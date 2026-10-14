import { describe, expect, it } from 'vitest'
import type { TransportEvent } from '../types'
import { NO_OUTPUT_MS, SOURCE_IDLE_MS, TARGET_IDLE_MS, TranslateSegmenter } from './segmenter'

const finals = (events: TransportEvent[]) =>
  events.flatMap((e) => (e.type === 'transcript' && e.final ? [`${e.utteranceId}:${e.role}:${e.text}`] : []))

describe('TranslateSegmenter', () => {
  it('cuts a line at a pause and closes the translation after it goes quiet', () => {
    const s = new TranslateSegmenter('s')
    const ev: TransportEvent[] = []
    ev.push(...s.speechStart(0))
    ev.push(...s.inputDelta('Where is ', 100), ...s.inputDelta('the pharmacy?', 400))
    ev.push(...s.outputDelta('¿Dónde está ', 600).events)
    ev.push(...s.speechEnd(900))
    ev.push(...s.tick(900 + SOURCE_IDLE_MS - 1))
    expect(finals(ev)).toEqual([])
    ev.push(...s.tick(900 + SOURCE_IDLE_MS))
    ev.push(...s.outputDelta('la farmacia?', 1800).events)
    ev.push(...s.tick(1800 + TARGET_IDLE_MS))
    expect(finals(ev)).toEqual(['s1:source:Where is the pharmacy?', 's1:target:¿Dónde está la farmacia?'])
    expect(ev.filter((e) => e.type === 'mark')).toEqual([
      { type: 'mark', name: 'speech.start', t: 0, utteranceId: 's1' },
      { type: 'mark', name: 'speech.end', t: 900, utteranceId: 's1' },
    ])
  })

  it('gives late translation to the earlier line, not the one being spoken now', () => {
    const s = new TranslateSegmenter('s')
    s.speechStart(0)
    s.inputDelta('First.', 100)
    s.speechEnd(500)
    s.speechStart(700)
    s.inputDelta('Second.', 800)
    const late = s.outputDelta('Primero.', 900)
    expect(late.first).toBe('s1')
    expect(late.events[0]).toMatchObject({ role: 'target', utteranceId: 's1' })
  })

  it('reports the first target text of each line once, to arm the first-audio probe', () => {
    const s = new TranslateSegmenter('s')
    s.speechStart(0)
    s.inputDelta('Hello', 100)
    expect(s.outputDelta('Hola', 300).first).toBe('s1')
    expect(s.outputDelta(' amigo', 400).first).toBeNull()
  })

  it('drops a noise blip with no text instead of making an empty line', () => {
    const s = new TranslateSegmenter('s')
    const ev = [...s.speechStart(0), ...s.speechEnd(200), ...s.tick(200 + NO_OUTPUT_MS)]
    expect(ev).toEqual([])
    s.speechStart(10_000)
    expect(s.inputDelta('Hi', 10_100)[0]).toMatchObject({ type: 'mark', name: 'speech.start', utteranceId: 's2' })
  })

  it('closes a line with an empty translation when none comes, so the output checks flag it', () => {
    const s = new TranslateSegmenter('s')
    s.speechStart(0)
    s.inputDelta('Do not translate this part.', 100)
    s.speechEnd(500)
    const ev = [...s.tick(500 + SOURCE_IDLE_MS), ...s.tick(500 + SOURCE_IDLE_MS + NO_OUTPUT_MS)]
    expect(finals(ev)).toEqual(['s1:source:Do not translate this part.', 's1:target:'])
  })

  it('finishes every open line when the connection closes', () => {
    const s = new TranslateSegmenter('s')
    s.speechStart(0)
    s.inputDelta('Still talking', 100)
    s.outputDelta('Todavía', 200)
    expect(finals(s.flush())).toEqual(['s1:source:Still talking', 's1:target:Todavía'])
    expect(s.flush()).toEqual([])
  })
})
