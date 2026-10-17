import { describe, expect, it, vi } from 'vitest'
import { cancelNotice, speakNotice } from './spokenNotice'

function fakeSynth(voices: Array<{ lang: string; localService: boolean; name: string }> = []) {
  const spoken: Array<{ text: string; lang: string; voice?: unknown }> = []
  return {
    spoken,
    synth: {
      getVoices: () => voices as unknown as SpeechSynthesisVoice[],
      cancel: vi.fn(),
      speak: (u: SpeechSynthesisUtterance) => {
        spoken.push({ text: u.text, lang: u.lang, voice: u.voice })
        queueMicrotask(() => u.onend?.(new Event('end') as SpeechSynthesisEvent))
      },
    },
  }
}

const make = (text: string) =>
  ({ text, lang: '', voice: null, onend: null, onerror: null }) as unknown as SpeechSynthesisUtterance

describe('speakNotice', () => {
  it('reads each line in order, in its language', async () => {
    const { synth, spoken } = fakeSynth()
    const ok = await speakNotice(
      [
        { text: 'AI interpreter', lang: 'en' },
        { text: 'Intérprete IA', lang: 'es' },
      ],
      synth,
      make,
    )
    expect(ok).toBe(true)
    expect(spoken.map((s) => [s.text, s.lang])).toEqual([
      ['AI interpreter', 'en'],
      ['Intérprete IA', 'es'],
    ])
  })

  it('prefers an on-device voice for the language', async () => {
    const remote = { lang: 'es-ES', localService: false, name: 'remote' }
    const local = { lang: 'es-MX', localService: true, name: 'local' }
    const { synth, spoken } = fakeSynth([remote, local])
    await speakNotice([{ text: 'Hola', lang: 'es' }], synth, make)
    expect(spoken[0].voice).toBe(local)
  })

  it('is a no-op without speech synthesis', async () => {
    expect(await speakNotice([{ text: 'x', lang: 'en' }], undefined)).toBe(false)
  })

  it('gives up on a line that never ends', async () => {
    vi.useFakeTimers()
    const synth = { getVoices: () => [], cancel: vi.fn(), speak: vi.fn() }
    const done = speakNotice([{ text: 'stuck', lang: 'en' }], synth, make)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(done).resolves.toBe(true)
    expect(synth.cancel).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('gives a line written without spaces time by its length, not its word count', async () => {
    vi.useFakeTimers()
    const synth = { getVoices: () => [], cancel: vi.fn(), speak: vi.fn() }
    void speakNotice(
      [{ text: 'これはAI通訳です。第三者のAIサービスがこの音声を処理します。', lang: 'ja' }],
      synth,
      make,
    )
    await vi.advanceTimersByTimeAsync(4_000)
    expect(synth.cancel).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('stops at cancelNotice and starts no further line', async () => {
    const spoken: string[] = []
    let current: SpeechSynthesisUtterance | null = null
    const synth = {
      getVoices: () => [],
      cancel: vi.fn(() => current?.onerror?.(new Event('error') as SpeechSynthesisErrorEvent)),
      speak: (u: SpeechSynthesisUtterance) => {
        spoken.push(u.text)
        current = u
      },
    }
    const done = speakNotice(
      [
        { text: 'one', lang: 'en' },
        { text: 'two', lang: 'es' },
      ],
      synth,
      make,
    )
    cancelNotice(synth)
    await done
    expect(spoken).toEqual(['one'])
  })
})
