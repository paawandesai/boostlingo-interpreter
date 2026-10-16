import { describe, expect, it } from 'vitest'
import type { TransportEvent } from '../types'
import fixture from './__fixtures__/en-es-turn.json'
import { RealtimeEventParser } from './events'

function runFixture(events: object[]): TransportEvent[] {
  let clock = 1000
  const parser = new RealtimeEventParser(() => (clock += 10))
  return events.flatMap((e) => parser.parse(JSON.stringify(e)))
}

describe('RealtimeEventParser', () => {
  const out = runFixture(fixture)

  it('emits endpoint and response.created marks for the user item', () => {
    const marks = out.filter((e) => e.type === 'mark')
    expect(marks).toEqual([
      { type: 'mark', name: 'endpoint', t: 1030, utteranceId: 'item_U1' },
      { type: 'mark', name: 'response.created', t: 1060, utteranceId: 'item_U1' },
    ])
  })

  it('accumulates source partials and replaces them with the final', () => {
    const source = out.filter((e) => e.type === 'transcript' && e.role === 'source')
    expect(source.map((e) => e.type === 'transcript' && [e.text, e.final])).toEqual([
      ['Where is', false],
      ['Where is the pharmacy?', false],
      ['Where is the pharmacy?', true],
    ])
  })

  it('attributes the translation to the user utterance, not the assistant item', () => {
    const target = out.filter((e) => e.type === 'transcript' && e.role === 'target')
    expect(target.at(-1)).toEqual({
      type: 'transcript',
      role: 'target',
      utteranceId: 'item_U1',
      text: '¿Dónde está la farmacia?',
      final: true,
    })
    expect(target.every((e) => e.type === 'transcript' && e.utteranceId === 'item_U1')).toBe(true)
  })

  it('reports usage from response.done for cost', () => {
    expect(out.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      utteranceId: 'item_U1',
      usage: {
        inputTokens: 200,
        outputTokens: 60,
        inputAudioTokens: 40,
        inputTextTokens: 160,
        cachedTokens: 0,
        outputAudioTokens: 48,
        outputTextTokens: 12,
      },
    })
  })

  it('keeps the cached input split by modality when the API reports it', () => {
    const parser = new RealtimeEventParser(() => 0)
    const done = {
      type: 'response.done',
      response: {
        id: 'resp_R2',
        status: 'completed',
        usage: {
          input_tokens: 300,
          output_tokens: 10,
          input_token_details: {
            audio_tokens: 100,
            text_tokens: 200,
            cached_tokens: 150,
            cached_tokens_details: { text_tokens: 120, audio_tokens: 30 },
          },
          output_token_details: { audio_tokens: 8, text_tokens: 2 },
        },
      },
    }

    const usage = parser.parse(JSON.stringify(done)).find((e) => e.type === 'usage')

    expect(usage).toMatchObject({ usage: { cachedTokens: 150, cachedTextTokens: 120, cachedAudioTokens: 30 } })
  })

  it('maps an empty transcription to empty_transcript', () => {
    const events = runFixture([
      { type: 'input_audio_buffer.speech_stopped', item_id: 'i', audio_end_ms: 0 },
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'i',
        content_index: 0,
        transcript: '  ',
      },
    ])
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'empty_transcript' })
  })

  it('maps rate-limit errors and ignores unknown events', () => {
    const events = runFixture([
      { type: 'error', error: { type: 'invalid_request_error', code: 'rate_limit_exceeded', message: 'slow down' } },
      { type: 'some.future.event' },
    ])
    expect(events).toEqual([{ type: 'error', kind: 'rate_limited', message: 'slow down' }])
  })
})
