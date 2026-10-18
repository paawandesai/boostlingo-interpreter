import { describe, expect, it } from 'vitest'
import { backAndForth } from './clipOrder'

describe('backAndForth', () => {
  it('alternates languages, each in name order, whatever order the files come in', () => {
    expect(backAndForth(['es-02.wav', 'en-02.wav', 'en-01.wav', 'es-01.wav', 'en-03.wav'])).toEqual([
      'en-01.wav',
      'es-01.wav',
      'en-02.wav',
      'es-02.wav',
      'en-03.wav',
    ])
  })

  it('reads the language from the file name, not the folder, and puts unprefixed names last', () => {
    expect(backAndForth(['/clips/es-a.wav', '/clips/notes.wav', '/clips/en-a.wav'])).toEqual([
      '/clips/en-a.wav',
      '/clips/es-a.wav',
      '/clips/notes.wav',
    ])
  })
})
