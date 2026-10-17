import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBanner } from './ErrorBanner'

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('ErrorBanner', () => {
  it('keeps Retry disabled until the Retry-After has elapsed, counting down', () => {
    const onRetry = vi.fn()
    const error = { kind: 'rate_limited' as const, message: 'slow', retryAfterMs: 3000 }
    act(() => root.render(<ErrorBanner error={error} onRetry={onRetry} onDismiss={() => {}} />))
    const button = () => container.querySelector('button')!

    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe('Retry in 3 s')
    button().click()
    expect(onRetry).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1250))
    expect(button().textContent).toBe('Retry in 2 s')
    act(() => vi.advanceTimersByTime(2000))
    expect(button().disabled).toBe(false)
    expect(button().textContent).toBe('Retry')
    button().click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('enables Retry at once when there is no Retry-After', () => {
    const error = { kind: 'timeout' as const, message: 'late' }
    act(() => root.render(<ErrorBanner error={error} onRetry={() => {}} onDismiss={() => {}} />))
    expect(container.querySelector('button')!.disabled).toBe(false)
    expect(container.querySelector('button')!.textContent).toBe('Retry')
  })
})
