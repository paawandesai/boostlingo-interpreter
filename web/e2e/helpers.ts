import { expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __live: {
      /** Open interpreter sockets and peer connections, and live AudioContexts. */
      counts(): { ws: number; pc: number; ctx: number }
      /** Connections that closed or failed while the page had not asked them to. */
      drops: Array<{ kind: 'ws' | 'pc'; detail: string; at: number }>
      ending: boolean
    }
  }
}

/** Tracks the app's sockets, peer connections and audio contexts so tests can check for leaks and drops. */
export async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const ws = new Set<WebSocket>()
    const clientClosed = new WeakSet<WebSocket>()
    const pc = new Set<RTCPeerConnection>()
    const ctx = new Set<AudioContext>()
    const live: Window['__live'] = {
      counts: () => ({
        ws: [...ws].filter((w) => w.readyState === WebSocket.OPEN || w.readyState === WebSocket.CONNECTING).length,
        pc: pc.size,
        ctx: [...ctx].filter((c) => c.state !== 'closed').length,
      }),
      drops: [],
      ending: false,
    }
    window.__live = live
    const WS = window.WebSocket
    window.WebSocket = class extends WS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (!String(url).includes('/ws/')) return
        ws.add(this)
        this.addEventListener('close', (e) => {
          ws.delete(this)
          // Only a close the page asked for (End, mode switch) is clean. A server-initiated close counts as a
          // drop whatever its code: a 1000 from the server mid-run once hid a session that ended at 3.9 of 5
          // minutes.
          if (!clientClosed.has(this))
            live.drops.push({ kind: 'ws', detail: `server close ${e.code}`, at: performance.now() })
        })
      }

      close(code?: number, reason?: string) {
        clientClosed.add(this)
        super.close(code, reason)
      }
    }
    const PC = window.RTCPeerConnection
    window.RTCPeerConnection = class extends PC {
      constructor(config?: RTCConfiguration) {
        super(config)
        pc.add(this)
        this.addEventListener('connectionstatechange', () => {
          if (this.connectionState === 'failed' || this.connectionState === 'disconnected')
            live.drops.push({ kind: 'pc', detail: this.connectionState, at: performance.now() })
        })
      }
      close() {
        pc.delete(this)
        super.close()
      }
    }
    const AC = window.AudioContext
    window.AudioContext = class extends AC {
      constructor(options?: AudioContextOptions) {
        super(options)
        ctx.add(this)
      }
    }
  })
}

export const accessToken = () => process.env.DEMO_ACCESS_TOKEN ?? 'devtoken'

/** Fills the setup screen and starts a session in the given mode. */
export async function startSession(
  page: Page,
  mode: 'Realtime translate' | 'Realtime' | 'Cascade',
  opts: { replayFiles?: string[]; query?: string } = {},
): Promise<void> {
  // The AI notice is always read aloud (G7). Headless Chromium has no voices, so a stand-in synthesizer
  // finishes each line at once; the app still waits for it before the mic opens.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [],
        cancel: () => {},
        speak: (u: SpeechSynthesisUtterance) =>
          setTimeout(() => u.onend?.(new Event('end') as SpeechSynthesisEvent), 0),
      },
    })
  })
  await page.goto(`/${opts.query ?? ''}`)
  await page.getByRole('radio', { name: mode, exact: true }).click()
  await page.fill('#access-token', accessToken())
  if (opts.replayFiles?.length) {
    await page.setInputFiles('#replay-files', opts.replayFiles)
    await expect(page.getByText(/^Replaying \d+ clip/)).toBeVisible()
  }
  await page.getByLabel('Both parties were told').check()
  await page.getByRole('button', { name: 'Start session' }).click()
  await expect(page.getByRole('button', { name: 'End' })).toBeVisible()
}
