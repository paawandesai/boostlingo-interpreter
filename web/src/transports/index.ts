/**
 * The only module outside transports/<mode>/ that knows the concrete transports.
 * The session store calls this; UI components never import a transport directly.
 */
import { RealtimeTransport } from './realtime/RealtimeTransport'
import type { Mode, Transport } from './types'

export function createTransport(mode: Mode): Transport {
  switch (mode) {
    case 'realtime':
      return new RealtimeTransport()
    case 'cascade':
      throw new Error('Cascade mode lands in Day 2 (T2.6)')
  }
}

export type * from './types'
