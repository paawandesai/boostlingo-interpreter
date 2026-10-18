import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initialState, type SessionState } from '../session/store'
import { SetupPanel } from './SetupPanel'

// Decoding needs an AudioContext; the order the clips arrive in is what these tests check.
vi.mock('../audio/replay', () => ({
  decodeClips: async (clips: { name: string }[]) => clips.map((c) => ({ name: c.name })),
}))

// What GET /api/realtime/models returns on a server that allows the brief's model next to the default.
const models = { default: 'gpt-realtime-2.1', allowed: ['gpt-realtime-2.1', 'gpt-realtime'] }

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
})

// Synthetic notice text: the gate only needs both languages to have one.
const disclosure = { notice: 'Synthetic on-screen notice.', spoken: 'Synthetic spoken notice.' }
const withNotices = {
  languages: [
    { code: 'en', name: 'English', disclosure },
    { code: 'es', name: 'Spanish', disclosure },
  ],
  pairs: [['en', 'es']] as [string, string][],
}

function render(state: SessionState, props: Partial<Parameters<typeof SetupPanel>[0]> = {}) {
  const onConfigure = vi.fn()
  const onStart = vi.fn()
  const element = (s: SessionState) => (
    <SetupPanel
      state={s}
      languages={withNotices}
      models={models}
      cascadeProviders={null}
      glossaryTerms={null}
      onConfigure={onConfigure}
      onSpeaker={() => {}}
      onStart={onStart}
      replay={[]}
      onReplay={() => {}}
      {...props}
    />
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(element(state)))
  return { onConfigure, onStart, rerender: (next: SessionState) => act(() => root.render(element(next))) }
}

const modelSelect = () => container.querySelector<HTMLSelectElement>('#rt-model')
const startButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Start session')!

/** Types into a controlled input the way a user would (React ignores a plain .value assignment). */
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('SetupPanel model select', () => {
  it('lists the allowed models with the default and deprecation hints and reports the pick', () => {
    const { onConfigure, rerender } = render({ ...initialState, mode: 'realtime' })
    const select = modelSelect()!
    expect(Array.from(select.options, (o) => [o.value, o.textContent])).toEqual([
      ['gpt-realtime-2.1', 'gpt-realtime-2.1 (default)'],
      ['gpt-realtime', 'gpt-realtime (deprecated by OpenAI)'],
    ])
    expect(select.value).toBe('gpt-realtime-2.1')

    act(() => {
      select.value = 'gpt-realtime'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onConfigure).toHaveBeenCalledWith({ realtimeModel: 'gpt-realtime' })

    // The store echoes the pick back as state.realtimeModel; the select follows it.
    rerender({ ...initialState, mode: 'realtime', realtimeModel: 'gpt-realtime' })
    expect(modelSelect()!.value).toBe('gpt-realtime')
  })

  it('shows the select only in Realtime mode and only once the models loaded', () => {
    render({ ...initialState, mode: 'translate' })
    expect(modelSelect()).toBeNull()
    act(() => root.unmount())
    container.remove()
    render({ ...initialState, mode: 'realtime' }, { models: null })
    expect(modelSelect()).toBeNull()
  })
})

describe('SetupPanel start gate', () => {
  it('needs the access token and the consent box before Start is enabled', () => {
    const { onStart } = render({ ...initialState, mode: 'realtime' })
    const start = startButton()
    expect(start.disabled).toBe(true)
    expect(start.title).toBe('Enter the access token first')

    type(container.querySelector<HTMLInputElement>('#access-token')!, 'invite-code')
    expect(start.disabled).toBe(true)
    expect(start.title).toBe('Confirm both parties agreed first')

    const consent = Array.from(container.querySelectorAll('label')).find((l) =>
      l.textContent?.startsWith('Both parties were told'),
    )!
    act(() => consent.querySelector('input')!.click())
    expect(start.disabled).toBe(false)
    expect(start.title).toBe('')

    act(() => start.click())
    expect(onStart).toHaveBeenCalled()
  })

  it('has no switch to skip the spoken notice (G7)', () => {
    render({ ...initialState, mode: 'realtime' })
    expect(container.textContent).toContain('read aloud in both languages')
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
  })

  it('keeps Start disabled when the notice could not be loaded', () => {
    render({ ...initialState, mode: 'realtime' }, { languages: null })
    type(container.querySelector<HTMLInputElement>('#access-token')!, 'invite-code')
    const consent = Array.from(container.querySelectorAll('label')).find((l) =>
      l.textContent?.startsWith('Both parties were told'),
    )!
    act(() => consent.querySelector('input')!.click())

    expect(startButton().disabled).toBe(true)
    expect(startButton().title).toBe('The AI notice could not be loaded from the server')
  })

  it('keeps Start disabled when a language of the pair has no notice', () => {
    const languages = {
      languages: [
        { code: 'en', name: 'English', disclosure },
        { code: 'es', name: 'Spanish' },
      ],
      pairs: [['en', 'es']] as [string, string][],
    }
    render({ ...initialState, mode: 'realtime' }, { languages })
    expect(startButton().disabled).toBe(true)
    expect(startButton().title).toBe('No AI notice is configured for Spanish')
  })

  it('treats a blank token as missing', () => {
    render({ ...initialState, mode: 'realtime' })
    type(container.querySelector<HTMLInputElement>('#access-token')!, '   ')
    expect(startButton().disabled).toBe(true)
    expect(startButton().title).toBe('Enter the access token first')
  })
})

describe('SetupPanel in BAA mode', () => {
  it('disables a mode the server blocks and shows its reason', () => {
    const reason = 'BAA mode is on: Realtime translate is off'
    const languages = {
      languages: [
        { code: 'en', name: 'English', realtimeTranslate: true },
        { code: 'es', name: 'Spanish', realtimeTranslate: true },
      ],
      pairs: [['en', 'es']] as [string, string][],
      blockedModes: { translate: reason },
    }
    render({ ...initialState, mode: 'realtime' }, { languages })
    const button = (label: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((b) =>
        b.textContent?.startsWith(label),
      )!

    expect(button('Realtime translate').disabled).toBe(true)
    expect(button('Realtime translate').title).toBe(reason)
    expect(button('Cascade').disabled).toBe(false)
  })
})

describe('SetupPanel consent vendors', () => {
  const vendorHint = () =>
    Array.from(container.querySelectorAll('.hint')).find((p) => p.textContent?.startsWith('This session may use'))!
      .textContent

  it('names the vendors of every mode the session could switch into, not only the chosen one', () => {
    render(
      { ...initialState, mode: 'realtime' },
      { cascadeProviders: { stt: 'deepgram', translator: 'anthropic', tts: 'elevenlabs' } },
    )
    expect(vendorHint()).toContain('This session may use: OpenAI, Deepgram, Anthropic, ElevenLabs')
  })

  it('leaves out a mode BAA mode blocks', () => {
    const languages = { ...withNotices, blockedModes: { cascade: 'BAA mode is on' } }
    render(
      { ...initialState, mode: 'realtime' },
      { languages, cascadeProviders: { stt: 'deepgram', translator: 'anthropic', tts: 'elevenlabs' } },
    )
    expect(vendorHint()).toContain('This session may use: OpenAI (')
  })
})

describe('SetupPanel language pair change', () => {
  const languages = (blockedModes?: Record<string, string>) => ({
    languages: [
      { code: 'en', name: 'English', disclosure, realtimeTranslate: true },
      { code: 'es', name: 'Spanish', disclosure, realtimeTranslate: true },
      { code: 'vi', name: 'Vietnamese', disclosure },
    ],
    pairs: [
      ['en', 'es'],
      ['en', 'vi'],
    ] as [string, string][],
    blockedModes,
  })
  function pick(value: string) {
    const select = container.querySelector<HTMLSelectElement>('#pair')!
    act(() => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('keeps the chosen mode when it can still run the new pair', () => {
    const { onConfigure } = render(
      { ...initialState, mode: 'cascade', langA: 'en', langB: 'vi' },
      { languages: languages() },
    )
    pick('en|es')
    expect(onConfigure).toHaveBeenLastCalledWith({ langA: 'en', langB: 'es', mode: 'cascade' })
  })

  it('falls back to the default only when the chosen mode cannot run the new pair', () => {
    const { onConfigure } = render({ ...initialState, mode: 'translate' }, { languages: languages() })
    pick('en|vi')
    expect(onConfigure).toHaveBeenLastCalledWith({ langA: 'en', langB: 'vi', mode: 'realtime' })
  })

  it('never falls back into a mode BAA mode blocks', () => {
    const { onConfigure } = render(
      { ...initialState, mode: 'translate' },
      { languages: languages({ realtime: 'BAA mode is on' }) },
    )
    pick('en|vi')
    expect(onConfigure).toHaveBeenLastCalledWith({ langA: 'en', langB: 'vi', mode: 'cascade' })
  })
})

describe('SetupPanel replay input', () => {
  it('orders picked clips as a back-and-forth between the two languages', async () => {
    const onReplay = vi.fn()
    render(initialState, { onReplay })
    const input = container.querySelector<HTMLInputElement>('#replay-files')!
    const names = ['en-b.wav', 'es-a.wav', 'en-a.wav', 'es-b.wav', 'en-c.wav']
    Object.defineProperty(input, 'files', { value: names.map((n) => new File(['x'], n)) })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await vi.waitFor(() => expect(onReplay).toHaveBeenCalled())
    expect(onReplay.mock.calls[0][0].map((c: { name: string }) => c.name)).toEqual([
      'en-a.wav',
      'es-a.wav',
      'en-b.wav',
      'es-b.wav',
      'en-c.wav',
    ])
  })
})
