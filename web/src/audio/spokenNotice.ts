/**
 * Reads the AI-use notice aloud before capture starts (G7), in each party's language, with the
 * browser's own speech synthesis. It runs before the mic opens, so the notice is never captured
 * or sent to a provider. Resolves when done, or after a timeout, and never throws: a browser
 * without speech synthesis still shows the written notice.
 */
export interface NoticeLine {
  text: string
  lang: string
}

type Synth = Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices'>
type MakeUtterance = (text: string) => SpeechSynthesisUtterance

const PER_LINE_TIMEOUT_MS = 15_000

export async function speakNotice(
  lines: NoticeLine[],
  synth: Synth | undefined = globalThis.speechSynthesis,
  make: MakeUtterance = (text) => new SpeechSynthesisUtterance(text),
): Promise<boolean> {
  if (!synth) return false
  for (const line of lines) {
    await new Promise<void>((resolve) => {
      const u = make(line.text)
      u.lang = line.lang
      // Prefer an on-device voice so the notice text stays local.
      const voices = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith(line.lang.toLowerCase()))
      const voice = voices.find((v) => v.localService) ?? voices[0]
      if (voice) u.voice = voice
      const timer = setTimeout(() => {
        synth.cancel()
        resolve()
      }, PER_LINE_TIMEOUT_MS)
      u.onend = u.onerror = () => {
        clearTimeout(timer)
        resolve()
      }
      synth.speak(u)
    })
  }
  return true
}
