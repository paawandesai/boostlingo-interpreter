import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mode, Transport, TransportListener } from '../transports/types'
import { useSession } from './useSession'

/** A transport whose stop() can be held open, to put a click in the middle of a mode switch. */
class FakeTransport implements Transport {
  listeners = new Set<TransportListener>()
  holdStop: Promise<void> | null = null
  readonly mode: Mode
  constructor(mode: Mode) {
    this.mode = mode
  }
  start = vi.fn(async () => {
    for (const l of this.listeners) l({ type: 'state', state: 'live' })
  })
  stop = vi.fn(async () => {
    await this.holdStop
  })
  setSpeaker = vi.fn()
  subscribe(l: TransportListener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

const created: FakeTransport[] = []
vi.mock('../transports', () => ({
  createTransport: (mode: Mode) => {
    const t = new FakeTransport(mode)
    created.push(t)
    return t
  },
}))
vi.mock('../audio/spokenNotice', () => ({ cancelNotice: () => {} }))

type Session = ReturnType<typeof useSession>
let session: Session
let container: HTMLDivElement
let root: Root

function Probe() {
  // eslint-disable-next-line react-hooks/globals -- the test reads the hook's result from outside React
  session = useSession()
  return null
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  created.length = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Probe />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useSession', () => {
  it.each(['end', 'requestHuman'] as const)(
    'does not restart the session when %s runs during a mode switch',
    async (action) => {
      await act(() => session.start())
      expect(session.state.status).toBe('live')
      let release!: () => void
      created[0].holdStop = new Promise((r) => (release = r))

      let switching!: Promise<void>
      await act(async () => {
        switching = session.switchMode('cascade')
        await Promise.resolve()
      })
      await act(async () => {
        const ending = session[action]()
        release()
        await Promise.all([switching, ending])
      })

      expect(created).toHaveLength(1)
      expect(session.state.status).toBe('ended')
    },
  )

  it('leaves the live state and releases the transport when it ends the session itself', async () => {
    await act(() => session.start())
    const t = created[0]
    await act(async () => {
      for (const l of t.listeners) l({ type: 'transcript', role: 'source', utteranceId: 'u1', text: 'Hi', final: true })
      for (const l of t.listeners) l({ type: 'error', kind: 'unavailable', message: 'limit reached' })
      for (const l of t.listeners) l({ type: 'state', state: 'closed' })
    })

    expect(session.state.status).toBe('ended')
    expect(session.state.error?.message).toBe('limit reached')
    // Kept for export on the setup screen; the next start discards it.
    expect(session.state.timeline).toHaveLength(1)
    expect(t.stop).toHaveBeenCalled()
    expect(created).toHaveLength(1)
  })

  it('ignores a tap on the side already selected and forwards a real flip', async () => {
    await act(() => session.start())
    const t = created[0]
    act(() => session.setSpeaker('A'))
    expect(t.setSpeaker).not.toHaveBeenCalled()
    act(() => session.setSpeaker('B'))
    act(() => session.setSpeaker('B'))
    expect(t.setSpeaker.mock.calls).toEqual([['B']])
    expect(session.state.speaker).toBe('B')
  })

  it('still switches modes when nothing interrupts the switch', async () => {
    await act(() => session.start())
    await act(() => session.switchMode('cascade'))

    expect(created.map((t) => t.mode)).toEqual(['translate', 'cascade'])
    expect(session.state.status).toBe('live')
  })
})
