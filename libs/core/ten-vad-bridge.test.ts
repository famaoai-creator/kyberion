import { describe, expect, it } from 'vitest';
import { probeTenVad, TenVad } from './ten-vad-bridge.js';
import type { AudioChunk } from './meeting-session-types.js';

function fakeBridgeCommand(): string[] {
  return [
    process.execPath,
    '-e',
    [
      'process.stdin.setEncoding("utf8");let b="";',
      'process.stdin.on("data",d=>{b+=d;let i;',
      'while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;',
      'const m=JSON.parse(l);console.log(JSON.stringify(m.reset?{ok:true}:{prob:0.95}))}});',
    ].join(''),
  ];
}

function chunkOf(ms = 100): AudioChunk {
  return {
    format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
    payload: new Uint8Array(ms * 32),
    ts_ms: 0,
  };
}

describe('TEN VAD bridge', () => {
  it('accepts an injected command for deterministic probes', () => {
    expect(probeTenVad({ command: fakeBridgeCommand() })).toEqual({ available: true });
  });

  it('uses the streaming protocol and reports speech', async () => {
    const vad = new TenVad({ command: fakeBridgeCommand(), endpointMs: 200 });
    try {
      vad.ingest(chunkOf());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(vad.ingest(chunkOf()).speaking).toBe(true);
      expect(vad.degradedReason).toBeNull();
    } finally {
      vad.dispose();
    }
  });
});
