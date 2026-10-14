import { describe, expect, it } from 'vitest'
import { langFromName } from './replay'

describe('langFromName', () => {
  it('reads the language from the file-name prefix', () => {
    expect(langFromName('en-01.wav')).toBe('en')
    expect(langFromName('ES_medical_3.webm')).toBe('es')
  })

  it('returns null when there is no prefix', () => {
    expect(langFromName('clip.wav')).toBeNull()
    expect(langFromName('english-01.wav')).toBeNull()
  })
})
