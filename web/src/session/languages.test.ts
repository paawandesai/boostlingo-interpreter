import { describe, expect, it } from 'vitest'
import { defaultMode, modeAvailable, type LanguagesResponse } from './languages'

const langs = (blockedModes?: LanguagesResponse['blockedModes']): LanguagesResponse => ({
  languages: [
    { code: 'en', name: 'English', realtimeTranslate: true },
    { code: 'es', name: 'Spanish', realtimeTranslate: true },
    { code: 'vi', name: 'Vietnamese' },
  ],
  pairs: [
    ['en', 'es'],
    ['en', 'vi'],
  ],
  blockedModes,
})

describe('defaultMode', () => {
  it('starts on Realtime translate where the pair is supported and nothing is blocked', () => {
    expect(defaultMode(langs(), 'en', 'es')).toBe('translate')
  })

  it('falls back to Realtime where translate does not support the pair', () => {
    expect(defaultMode(langs(), 'en', 'vi')).toBe('realtime')
  })

  it('skips a mode BAA mode blocks', () => {
    expect(defaultMode(langs({ translate: 'off', realtime: 'off' }), 'en', 'es')).toBe('cascade')
    expect(defaultMode(langs({ realtime: 'off' }), 'en', 'vi')).toBe('cascade')
  })

  it('takes Realtime when translate is blocked and Realtime is allowed', () => {
    expect(defaultMode(langs({ translate: 'off', cascade: 'off' }), 'en', 'es')).toBe('realtime')
  })

  it('returns Realtime when every mode is blocked, so the setup screen shows the reason', () => {
    expect(defaultMode(langs({ translate: 'off', realtime: 'off', cascade: 'off' }), 'en', 'es')).toBe('realtime')
  })

  it('falls back to Realtime with no language data', () => {
    expect(defaultMode(null, 'en', 'es')).toBe('realtime')
  })
})

describe('modeAvailable', () => {
  it('allows translate only where the pair supports it and BAA mode does not block it', () => {
    expect(modeAvailable(langs(), 'translate', 'en', 'es')).toBe(true)
    expect(modeAvailable(langs(), 'translate', 'en', 'vi')).toBe(false)
    expect(modeAvailable(langs({ translate: 'x' }), 'translate', 'en', 'es')).toBe(false)
  })

  it('allows Realtime and Cascade for any pair unless BAA mode blocks them', () => {
    expect(modeAvailable(langs(), 'realtime', 'en', 'vi')).toBe(true)
    expect(modeAvailable(langs({ realtime: 'x' }), 'realtime', 'en', 'es')).toBe(false)
    expect(modeAvailable(langs({ realtime: 'x' }), 'cascade', 'en', 'es')).toBe(true)
  })
})
