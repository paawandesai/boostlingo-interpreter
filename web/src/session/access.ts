/**
 * The demo access token the backend requires before it spends provider credit
 * (docs/GUARDRAILS.md, Keys and transport). The user types it once; it is kept in this
 * browser only. It is not a provider key and never ships in the bundle.
 */
const KEY = 'workbench.accessToken'

export function getAccessToken(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function setAccessToken(token: string): void {
  try {
    if (token) localStorage.setItem(KEY, token)
    else localStorage.removeItem(KEY)
  } catch {
    // Storage blocked (private window): the token lasts for this page only.
  }
  memory = token
}

let memory = ''

/** Headers for guarded backend calls. */
export function accessHeaders(): Record<string, string> {
  const token = getAccessToken() || memory
  return token ? { 'X-Access-Token': token } : {}
}
