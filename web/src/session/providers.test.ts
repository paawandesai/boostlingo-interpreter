import { describe, expect, it } from 'vitest'
import { vendorsFor } from './providers'

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
