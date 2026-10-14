import type { Mode } from '../transports/types'

/** What each mode is called on screen, in the latency tables and the export. */
export const MODE_LABEL: Record<Mode, string> = {
  translate: 'Realtime translate',
  realtime: 'Realtime',
  cascade: 'Cascade',
}
