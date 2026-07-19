/**
 * Minimal PCM_S16LE mono → WAV container helpers, shared by the mic
 * recording flows (in-room minutes, VAD turn recorder). Kept free of
 * I/O so callers stay on secure-io for writes.
 */

export function wavHeader(pcmBytes: number, sampleRateHz: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

export function pcmToWav(pcm: Buffer, sampleRateHz: number): Buffer {
  return Buffer.concat([wavHeader(pcm.length, sampleRateHz), pcm]);
}
