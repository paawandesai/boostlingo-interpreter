export interface LanguageInfo {
  code: string
  name: string
  /** AI-use notice in this language, shown and read aloud before capture (G7). */
  disclosure?: { notice: string; spoken: string }
  /** Output-check word lists (G15). */
  outputChecks?: { markers: string[]; assistantPatterns: string[]; refusalPatterns: string[] }
}

export interface LanguagesResponse {
  languages: LanguageInfo[]
  pairs: [string, string][]
  /** Prompt-leak canary from the interpreter instructions (G15); never expected in an output. */
  canary?: string
}

export async function fetchLanguages(fetchImpl: typeof fetch = fetch): Promise<LanguagesResponse> {
  const res = await fetchImpl('/api/languages')
  if (!res.ok) throw new Error(`Could not load languages: HTTP ${res.status}`)
  return (await res.json()) as LanguagesResponse
}
