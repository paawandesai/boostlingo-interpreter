/** A 440 Hz tone split into streaming-sized chunks, to exercise the playback scheduler. */
export function testToneChunks(sampleRate = 24000, seconds = 1, chunkMs = 100, freq = 440): Float32Array[] {
  const total = Math.round(sampleRate * seconds)
  const per = Math.round((sampleRate * chunkMs) / 1000)
  const chunks: Float32Array[] = []
  for (let start = 0; start < total; start += per) {
    const len = Math.min(per, total - start)
    chunks.push(
      Float32Array.from({ length: len }, (_, i) => 0.2 * Math.sin((2 * Math.PI * freq * (start + i)) / sampleRate)),
    )
  }
  return chunks
}
