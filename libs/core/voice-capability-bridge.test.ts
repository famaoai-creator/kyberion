import { describe, expect, it, vi } from 'vitest';

const probeNativeTts = vi.fn();
const speak = vi.fn();
vi.mock('./native-tts.js', () => ({ probeNativeTts, speak }));

describe('voice-capability-bridge', () => {
  it('exposes native voice probe and speak through one contract', async () => {
    probeNativeTts.mockResolvedValue({ available: true, platform: 'darwin' });
    speak.mockResolvedValue({ ok: true, platform: 'darwin', command: 'say' });
    const { createVoiceCapabilityBridge } = await import('./voice-capability-bridge.js');
    const bridge = createVoiceCapabilityBridge();
    expect(await bridge.probe()).toMatchObject({
      bridge_id: 'voice-capability-bridge',
      available: true,
    });
    expect(await bridge.speak('hello')).toMatchObject({ ok: true });
  });
});
