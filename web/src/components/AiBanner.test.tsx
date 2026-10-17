import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AiBanner } from './AiBanner'

describe('AiBanner', () => {
  it('says only what the app itself does with audio, not what providers do', () => {
    const html = renderToStaticMarkup(<AiBanner />)
    expect(html).toContain('This app saves no audio; providers may retain it under their terms.')
    expect(html).not.toContain('no audio is saved')
  })
})
