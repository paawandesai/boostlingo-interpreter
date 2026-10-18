import type { LanguagesResponse } from './languages'
import type { Utterance } from './store'

/**
 * Deterministic checks on every output segment, both modes (G15). They decide nothing on their own:
 * a failed check marks the line "possibly not a translation" and offers the human handoff, and the
 * text is always kept. Heuristics, not proof; a passing line is not verified either.
 * server/Interpreter.Core/Interpretation/OutputCheck.cs is a port of checkSegment that keeps flagged cascade
 * turns out of the server's translator context; change both together.
 */
export type CheckFlag =
  | 'refusal' // the model declined; shown as "[segment not interpreted — model declined]"
  | 'omission' // speech was recognised but nothing came out
  | 'prompt_leak' // the instructions' canary appeared in the output
  | 'assistant_reply' // assistant-style phrasing ("As an AI", "Sure, here's")
  | 'wrong_language' // the output reads as the source language, not the target
  | 'length_ratio' // far shorter or longer than the source

export interface OutputChecks {
  markers: string[]
  assistantPatterns: string[]
  refusalPatterns: string[]
}

export interface CheckContext {
  sourceLang: string
  targetLang: string
  checks: Record<string, OutputChecks | undefined>
  canary: string | null
}

export const FLAG_TEXT: Record<CheckFlag, string> = {
  refusal: 'the model declined',
  omission: 'nothing was interpreted',
  prompt_leak: 'it repeated its instructions',
  assistant_reply: 'it reads like an assistant reply',
  wrong_language: 'it is not in the target language',
  length_ratio: 'its length does not match what was said',
}

/** Length bounds (target chars / source chars) and the minimum source size they apply to. */
const RATIO_MIN = 0.4
const RATIO_MAX = 2.5
const RATIO_MIN_SOURCE_CHARS = 15
/** Language check needs this many words to say anything. */
const LANG_MIN_WORDS = 4

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
/** Lower case with contractions expanded, so "I'm unable" matches "i am unable"; applied to text and patterns. */
const CONTRACTIONS: Record<string, string> = {
  "i'm": 'i am',
  "here's": 'here is',
  "can't": 'cannot',
  "won't": 'will not',
}
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/(?<![\p{L}\p{N}'])(?:i'm|here's|can't|won't)(?![\p{L}\p{N}'])/gu, (m) => CONTRACTIONS[m])
/**
 * True when a clause starts with one of the patterns (after leading punctuation such as quotes or ¿, an
 * apology or filler such as "I'm afraid" or "lo siento", and a leading "but"/"and"). Only clause starts
 * count: a model's refusal or assistant preamble opens a clause ("I'm sorry I can't help", "Okay here's a
 * joke"), while the same words inside a faithful line ("I won't be able to...") do not. Keep in step with
 * OutputCheck.HasAny on the server.
 */
const hasAny = (text: string, patterns: string[] = []) => {
  const normalized = patterns.map(normalize)
  const clauses = normalize(text).split(/(?<=[.!?…,;:])\s+|\n+/u)
  // Each start is matched against the rest of the text, so a pattern with a comma ("sure, here's") still matches.
  return clauses
    .map((_, i) => clauses.slice(i).join(' '))
    .map((rest) =>
      rest
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(
          /^(?:i am afraid|i am sorry|sorry|unfortunately|okay|ok|lo siento|desafortunadamente|lamentablemente|tôi xin lỗi|xin lỗi|rất tiếc)[\s,]+/u,
          '',
        )
        .replace(/^(?:but|and|pero|y|nhưng|và)\s+/u, ''),
    )
    .some((rest) => normalized.some((p) => rest.startsWith(p)))
}

export function checkContext(
  languages: LanguagesResponse | null,
  sourceLang: string,
  targetLang: string,
): CheckContext {
  return {
    sourceLang,
    targetLang,
    checks: Object.fromEntries((languages?.languages ?? []).map((l) => [l.code, l.outputChecks])),
    canary: languages?.canary ?? null,
  }
}

/** Flags for a finished target segment; [] while it is still partial. */
export function checkSegment(source: string, target: string, sourceFinal: boolean, ctx: CheckContext): CheckFlag[] {
  const flags: CheckFlag[] = []
  const tgt = ctx.checks[ctx.targetLang]
  const src = ctx.checks[ctx.sourceLang]
  const sourceWords = words(source)
  const targetWords = words(target)

  if (target.trim() === '') {
    if (sourceFinal && sourceWords.length >= 3) flags.push('omission')
    return flags
  }
  // A refusal the speaker said ("No puedo ayudarle con eso") translates to one; that is not the model declining.
  if (
    (hasAny(target, tgt?.refusalPatterns) || hasAny(target, src?.refusalPatterns)) &&
    !hasAny(source, src?.refusalPatterns) &&
    !hasAny(source, tgt?.refusalPatterns)
  )
    flags.push('refusal')
  if (ctx.canary && squash(target).includes(squash(ctx.canary))) flags.push('prompt_leak')
  // Same for assistant phrasing the speaker said ("Sure, here's my insurance card").
  if (
    (hasAny(target, tgt?.assistantPatterns) || hasAny(target, src?.assistantPatterns)) &&
    !hasAny(source, src?.assistantPatterns) &&
    !hasAny(source, tgt?.assistantPatterns)
  )
    flags.push('assistant_reply')
  if (targetWords.length >= LANG_MIN_WORDS && tgt && src) {
    // Distinct words, so one short word both languages share ("a" is also Spanish) can't flag a
    // correct line by repeating ("Voy a enviar una nueva receta a tu farmacia.").
    const distinct = [...new Set(targetWords)]
    const hits = (markers: string[]) => distinct.filter((w) => markers.includes(w)).length
    const asTarget = hits(tgt.markers)
    const asSource = hits(src.markers)
    if (asSource >= 2 && asSource > asTarget) flags.push('wrong_language')
  }
  if (sourceFinal && source.trim().length >= RATIO_MIN_SOURCE_CHARS) {
    const ratio = target.trim().length / source.trim().length
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) flags.push('length_ratio')
  }
  return flags
}

/** Checks one utterance; the source language is the speaking side's. */
export function checkUtterance(
  u: Utterance,
  langA: string,
  langB: string,
  ctx: Omit<CheckContext, 'sourceLang' | 'targetLang'>,
): CheckFlag[] {
  if (!u.target.final) return []
  const [sourceLang, targetLang] = u.side === 'A' ? [langA, langB] : [langB, langA]
  return checkSegment(u.source.text, u.target.text, u.source.final, { ...ctx, sourceLang, targetLang })
}
