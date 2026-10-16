import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initialState, type SessionState } from '../session/store'
import { SetupPanel } from './SetupPanel'

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

function render(state: SessionState, props: Partial<Parameters<typeof SetupPanel>[0]> = {}) {
  const onConfigure = vi.fn()
  const onStart = vi.fn()
  const element = (s: SessionState) => (
    <SetupPanel
      state={s}
      languages={null}
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
    expect(onStart).toHaveBeenCalledWith({ spokenNotice: true })
  })

  it('treats a blank token as missing', () => {
    render({ ...initialState, mode: 'realtime' })
    type(container.querySelector<HTMLInputElement>('#access-token')!, '   ')
    expect(startButton().disabled).toBe(true)
    expect(startButton().title).toBe('Enter the access token first')
  })
})
