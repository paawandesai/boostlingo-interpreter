import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Utterance } from '../session/store'
import { DECLINED, TranscriptColumn } from './TranscriptColumn'

const line = (target: string): Utterance => ({
  kind: 'utterance',
  id: 'u1',
  mode: 'cascade',
  side: 'A',
  source: { text: 'Describe the injury.', final: true },
  target: { text: target, final: true },
  marks: {},
})

describe('TranscriptColumn', () => {
  it('renders recognised text as text, never as markup', () => {
    const html = renderToStaticMarkup(
      <TranscriptColumn title="Target" role="target" timeline={[line('<img src=x onerror=alert(1)>')]} />,
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('shows a refusal as declined, keeps the model text and offers the handoff', () => {
    const html = renderToStaticMarkup(
      <TranscriptColumn
        title="Target"
        role="target"
        timeline={[line("I'm sorry, but I can't help with that.")]}
        flagsFor={() => ['refusal']}
        onRequestHuman={() => {}}
      />,
    )
    expect(html).toContain(DECLINED)
    expect(html).toContain('Possibly not a translation: the model declined.')
    expect(html).toContain('Request human interpreter')
  })
})
