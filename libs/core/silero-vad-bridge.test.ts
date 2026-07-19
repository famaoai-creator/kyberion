import { describe, expect, it } from 'vitest';

import { probeSileroVad, SileroVad } from './silero-vad-bridge.js';
import type { AudioChunk } from './meeting-session-types.js';

/**
 * Fake bridge process speaking the NDJSON protocol: decodes the PCM,
 * answers prob 0.95 for loud audio and 0.05 for silence.
 */
function fakeBridgeCommand(): string[] {
  return [
    process.execPath,
    '-e',
    [
      'process.stdin.setEncoding("utf8");let b="";',
      'process.stdin.on("data",d=>{b+=d;let i;',
      'while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);',
      'if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}',
      'if(m.reset){console.log(JSON.stringify({ok:true}));continue}',
      'const buf=Buffer.from(m.pcm,"base64");let s=0;',
      'for(let j=0;j+1<buf.length;j+=2){const v=buf.readInt16LE(j);s+=v*v}',
      'const r=Math.sqrt(s/((buf.length/2)||1));',
      'console.log(JSON.stringify({prob:r>500?0.95:0.05}))}});',
    ].join(''),
  ];
}

function chunkOf(amplitude: number, ms = 100): AudioChunk {
  const payload = Buffer.alloc(ms * 32);
  for (let i = 0; i < payload.length; i += 2) {
    payload.writeInt16LE(i % 4 === 0 ? amplitude : -amplitude, i);
  }
  return {
    format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
    payload: new Uint8Array(payload),
    ts_ms: 0,
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

describe('silero vad bridge', () => {
  it('probe fails without a configured model', () => {
    const previous = process.env.KYBERION_SILERO_VAD_MODEL;
    delete process.env.KYBERION_SILERO_VAD_MODEL;
    try {
      const probe = probeSileroVad({});
      expect(probe.available).toBe(false);
      expect(probe.reason).toMatch(/KYBERION_SILERO_VAD_MODEL/);
    } finally {
      if (previous !== undefined) process.env.KYBERION_SILERO_VAD_MODEL = previous;
    }
  });

  it(
    'detects speech and endpoints through the subprocess protocol',
    { timeout: 30_000 },
    async () => {
      const vad = new SileroVad({ command: fakeBridgeCommand(), endpointMs: 300 });
      try {
        // Warm up: the bridge is one chunk late by design.
        vad.ingest(chunkOf(8000));
        await settle();
        const speaking = vad.ingest(chunkOf(8000));
        expect(speaking.speaking).toBe(true);

        await settle();
        // Silence until the endpoint fires (prob for previous chunk arrives one call late).
        vad.ingest(chunkOf(0));
        await settle();
        let sawEndpoint = false;
        for (let i = 0; i < 6; i++) {
          const state = vad.ingest(chunkOf(0));
          if (state.endpoint) {
            sawEndpoint = true;
            break;
          }
          await settle();
        }
        expect(sawEndpoint).toBe(true);
        expect(vad.degradedReason).toBeNull();
      } finally {
        vad.dispose();
      }
    }
  );

  it('degrades to the energy fallback when the subprocess dies', { timeout: 30_000 }, async () => {
    const vad = new SileroVad({
      command: [process.execPath, '-e', 'process.exit(7)'],
      endpointMs: 300,
      fallbackRmsThreshold: 500,
    });
    try {
      await settle();
      const state = vad.ingest(chunkOf(8000));
      expect(vad.degradedReason).toMatch(/exited code=7/);
      // Energy fallback still detects the loud chunk as speech.
      expect(state.speaking).toBe(true);
    } finally {
      vad.dispose();
    }
  });
});
