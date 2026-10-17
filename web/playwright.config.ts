import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests (T3.6). They need the real backend; without E2E_BASE_URL both servers are
 * started here (reused when already running). The backend reads provider keys and
 * DEMO_ACCESS_TOKEN from the environment, so these runs make real, billed provider calls.
 * Against E2E_BASE_URL (the deployed demo) no trace is kept: helpers.ts types the demo's real access
 * token, and a trace would carry it into the CI artifacts. CI gives the local server a random token.
 */
const external = process.env.E2E_BASE_URL
const fakeAudio = process.env.E2E_FAKE_AUDIO

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/e2e-report' }]],
  use: {
    baseURL: external ?? 'http://localhost:5173',
    trace: external ? 'off' : 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            ...(fakeAudio ? [`--use-file-for-fake-audio-capture=${fakeAudio}`] : []),
          ],
        },
      },
    },
  ],
  webServer: external
    ? undefined
    : [
        {
          command: 'dotnet run --project ../server/Interpreter.Api',
          url: 'http://localhost:5080/health',
          reuseExistingServer: true,
          timeout: 240_000,
        },
        {
          command: 'npm run dev -- --port 5173 --strictPort',
          url: 'http://localhost:5173',
          reuseExistingServer: true,
          timeout: 60_000,
        },
      ],
})
