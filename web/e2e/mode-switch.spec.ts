import { expect, test } from '@playwright/test'
import { instrument, startSession } from './helpers'

// T3.3/G9: a mid-session switch tears the old transport down completely and keeps the transcript.
// Realtime only has to reach "connecting" here, so the test also passes where WebRTC can't connect.
test('switching modes mid-session leaves no socket, peer connection or audio context behind', async ({ page }) => {
  await instrument(page)
  await startSession(page, 'Cascade')
  await expect.poll(() => page.evaluate(() => window.__live.counts().ws)).toBe(1)

  await page.getByRole('radio', { name: 'Realtime', exact: true }).click()
  await expect(page.getByText(/Switched to Realtime\./).first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__live.counts().ws)).toBe(0)

  // G17: translate mints its own session (target language only) and offers WebRTC to the translations endpoint.
  const minted = page.waitForResponse((r) => r.url().endsWith('/api/realtime/translation-session'))
  await page.getByRole('radio', { name: 'Realtime translate', exact: true }).click()
  const r = await minted
  expect(r.status(), await r.text()).toBe(200)
  await expect(page.getByText(/Switched to Realtime translate/).first()).toBeVisible()

  await page.getByRole('radio', { name: 'Cascade', exact: true }).click()
  await expect(page.getByText(/Switched to Cascade/).first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__live.counts())).toMatchObject({ ws: 1, pc: 0 })

  await page.getByRole('button', { name: 'End' }).click()
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__live.counts())).toEqual({ ws: 0, pc: 0, ctx: 0 })
})
