import { describe, expect, it } from 'vitest';
import { resolveAudioBus } from './audio-bus-resolver.js';

describe('resolveAudioBus', () => {
  it('honors explicit override', () => {
    expect(resolveAudioBus('stub').bus_id).toBe('stub');
    expect(resolveAudioBus('blackhole').bus_id).toBe('blackhole');
    expect(resolveAudioBus('pulseaudio').bus_id).toBe('pulseaudio');
  });

  it('chooses by platform when no override is set', () => {
    const bus = resolveAudioBus(undefined);
    if (process.platform === 'darwin') expect(bus.bus_id).toBe('blackhole');
    else if (process.platform === 'linux') expect(bus.bus_id).toBe('pulseaudio');
    else expect(bus.bus_id).toBe('stub');
  });

  it('a stub bus probe is always available', async () => {
    const probe = await resolveAudioBus('stub').probe();
    expect(probe.available).toBe(true);
  });
});
