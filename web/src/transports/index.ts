/**
 * The only module outside transports/<mode>/ that knows the concrete transports.
 * The session store calls this; UI components never import a transport directly.
 */
import { CascadeTransport } from './cascade/CascadeTransport'
import { RealtimeTransport } from './realtime/RealtimeTransport'
import { TranslateTransport } from './translate/TranslateTransport'
import type { Mode, Transport } from './types'

export function createTransport(mode: Mode): Transport {
  switch (mode) {
    case 'translate':
      return new TranslateTransport()
    case 'realtime':
      return new RealtimeTransport()
    case 'cascade':
      return new CascadeTransport()
  }
}

export type * from './types'
