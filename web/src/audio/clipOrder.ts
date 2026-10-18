/**
 * Orders replay clip names as a back-and-forth (T3.6): the first clip of each language, then the second
 * of each, and so on, each language's clips in name order. A plain sort put every `en-*` clip before any
 * `es-*` one, so a 5-minute run that waits for each interpretation never reached the Spanish speaker
 * (the 2026-10-16 cascade run had 0 Spanish-to-English turns). Names without a language prefix go last.
 */
export function backAndForth(names: string[]): string[] {
  const byLang = new Map<string, string[]>()
  const rest: string[] = []
  for (const name of [...names].sort()) {
    const m = /^([a-z]{2})[-_]/i.exec(name.split(/[\\/]/).pop() ?? name)
    if (!m) {
      rest.push(name)
      continue
    }
    const lang = m[1].toLowerCase()
    byLang.set(lang, [...(byLang.get(lang) ?? []), name])
  }
  const lists = [...byLang.keys()].sort().map((k) => byLang.get(k)!)
  const out: string[] = []
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i])
  return [...out, ...rest]
}
