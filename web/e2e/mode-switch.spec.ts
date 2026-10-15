import { expect, test } from '@playwright/test'
import { instrument, startSession } from './helpers'

// T3.3/G9: a mid-session switch tears the old transport down completely and keeps the transcript.
// Realtime only has to reach "connecting" here, so the test also passes where WebRTC can't connect.
test('switching modes mid-session leaves no socket, peer connection or audio context behind', async ({ page }) => {
  await instrument(page)
  await startSession(page, 'Cascade')
  await expect.poll(() => page.evaluate(() => window.__live.counts().ws)).toBe(1)

  await page.getByRole('radio', { name: 'Realtime' }).click()
  await expect(page.getByText(/Switched to realtime/).first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__live.counts().ws)).toBe(0)

  await page.getByRole('radio', { name: 'Cascade' }).click()
  await expect(page.getByText(/Switched to cascade/).first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__live.counts())).toMatchObject({ ws: 1, pc: 0 })

  await page.getByRole('button', { name: 'End' }).click()
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__live.counts())).toEqual({ ws: 0, pc: 0, ctx: 0 })
})
