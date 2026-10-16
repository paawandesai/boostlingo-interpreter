import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicDeniedError, micConstraints, openMic } from './capture'

function stubGetUserMedia(impl: () => Promise<MediaStream>) {
  const getUserMedia = vi.fn(impl)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  return getUserMedia
}

afterEach(() => vi.unstubAllGlobals())

describe('openMic', () => {
  it('asks for the mic with echo cancellation and noise suppression on', async () => {
    const stream = {} as MediaStream
    const getUserMedia = stubGetUserMedia(() => Promise.resolve(stream))

    await expect(openMic()).resolves.toBe(stream)
    expect(getUserMedia).toHaveBeenCalledWith(micConstraints)
  })

  it.each(['NotAllowedError', 'SecurityError'])('turns a refused permission (%s) into MicDeniedError', async (name) => {
    stubGetUserMedia(() => Promise.reject(new DOMException('denied', name)))

    await expect(openMic()).rejects.toBeInstanceOf(MicDeniedError)
  })

  it('passes any other failure through unchanged', async () => {
    const missing = new DOMException('no device', 'NotFoundError')
    stubGetUserMedia(() => Promise.reject(missing))

    await expect(openMic()).rejects.toBe(missing)
  })
})
