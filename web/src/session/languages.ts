export interface LanguageInfo {
  code: string
  name: string
  /** AI-use notice in this language, shown and read aloud before capture (G7). */
  disclosure?: { notice: string; spoken: string }
  /** Output-check word lists (G15). */
  outputChecks?: { markers: string[]; assistantPatterns: string[]; refusalPatterns: string[] }
  /** gpt-realtime-translate can output this language (G17). */
  realtimeTranslate?: boolean
}

export interface LanguagesResponse {
  languages: LanguageInfo[]
  pairs: [string, string][]
  /** Prompt-leak canary from the interpreter instructions (G15); never expected in an output. */
  canary?: string
  /** Modes the server's BAA mode refuses, with the reason to show; empty or absent when it is off. */
  blockedModes?: Partial<Record<'translate' | 'realtime' | 'cascade', string>>
}

/** Realtime translate is offered only when the model can speak both languages of the pair and BAA mode allows it. */
export function translateSupported(langs: LanguagesResponse | null, a: string, b: string): boolean {
  if (langs?.blockedModes?.translate) return false
  const ok = (code: string) => langs?.languages.find((l) => l.code === code)?.realtimeTranslate === true
  return ok(a) && ok(b)
}

export async function fetchLanguages(fetchImpl: typeof fetch = fetch): Promise<LanguagesResponse> {
  const res = await fetchImpl('/api/languages')
  if (!res.ok) throw new Error(`Could not load languages: HTTP ${res.status}`)
  return (await res.json()) as LanguagesResponse
}
