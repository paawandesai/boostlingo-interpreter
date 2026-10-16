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
  const element = (
    <SetupPanel
      state={state}
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
  act(() => root.render(element))
  return {
    onConfigure,
    onStart,
    rerender: (next: SessionState) => act(() => root.render({ ...element, props: { ...element.props, state: next } })),
  }
}

const modelSelect = () => container.querySelector<HTMLSelectElement>('#rt-model')

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
