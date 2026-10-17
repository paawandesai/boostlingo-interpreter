import { describe, expect, it } from 'vitest'
import { vendorsFor, vendorsForModes } from './providers'

describe('vendorsFor', () => {
  it('names OpenAI only for Realtime', () => {
    expect(vendorsFor('realtime', null)).toEqual(['OpenAI'])
  })

  it('lists each cascade vendor once, with display names', () => {
    expect(vendorsFor('cascade', { stt: 'openai', translator: 'openai', tts: 'elevenlabs' })).toEqual([
      'OpenAI',
      'ElevenLabs',
    ])
    expect(vendorsFor('cascade', { stt: 'deepgram', translator: 'anthropic', tts: 'elevenlabs' })).toEqual([
      'Deepgram',
      'Anthropic',
      'ElevenLabs',
    ])
  })

  it('is unknown for cascade until the server answers', () => {
    expect(vendorsFor('cascade', null)).toBeNull()
  })
})

describe('vendorsForModes', () => {
  const cascade = { stt: 'deepgram', translator: 'anthropic', tts: 'elevenlabs' }

  it('lists every vendor of every mode the session could switch into, once each', () => {
    expect(vendorsForModes(['realtime', 'cascade'], cascade)).toEqual(['OpenAI', 'Deepgram', 'Anthropic', 'ElevenLabs'])
    expect(vendorsForModes(['translate', 'realtime'], null)).toEqual(['OpenAI'])
  })

  it('is unknown while any mode is, so it never names fewer vendors than may be used', () => {
    expect(vendorsForModes(['realtime', 'cascade'], null)).toBeNull()
    expect(vendorsForModes([], cascade)).toBeNull()
  })
})
