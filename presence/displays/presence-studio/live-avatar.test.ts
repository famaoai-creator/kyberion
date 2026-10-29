import { describe, expect, it, vi } from 'vitest';
import '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation/text';

async function setup() {
  const url = `data:text/javascript;base64,${Buffer.from(readTextFile('presence/displays/presence-studio/static/live-avatar.js')).toString('base64')}`;
  const { connectLiveAvatar } = await import(url);
  const handlers = new Map<string, (event: unknown) => void>();
  const close = vi.fn();
  class Source {
    constructor(url: string) {
      expect(url).toBe('/api/stream');
    }
    addEventListener(name: string, fn: (event: unknown) => void) {
      handlers.set(name, fn);
    }
    close = close;
  }
  const avatar = {
    followHost: vi.fn(),
    setState: vi.fn(),
    setExpression: vi.fn(),
    dispose: vi.fn(),
  };
  const onConnection = vi.fn();
  const dispose = connectLiveAvatar({ avatar, EventSourceImpl: Source, onConnection });
  const emit = (name: string, data: unknown) =>
    handlers.get(name)?.({ data: JSON.stringify(data) });
  return { avatar, onConnection, close, dispose, emit, handlers };
}
describe('OBS live avatar projection', () => {
  it('uses bounded host speech and resets mouth after disconnect', async () => {
    const { avatar, emit, onConnection } = await setup();
    emit('speech_state', { speech: { status: 'speaking', estimated_ms: Infinity } });
    expect(avatar.followHost).toHaveBeenLastCalledWith({ speaking: true, estimatedMs: 15000 });
    emit('speech_state', { speech: { status: 'speaking', estimated_ms: 999999 } });
    expect(avatar.followHost).toHaveBeenLastCalledWith({ speaking: true, estimatedMs: 120000 });
    emit('error', {});
    expect(avatar.followHost).toHaveBeenLastCalledWith({ speaking: false });
    expect(avatar.setState).toHaveBeenLastCalledWith('idle');
    expect(onConnection).toHaveBeenLastCalledWith('offline');
  });
  it('ignores unrelated surfaces and malformed payloads; never starts speech from status alone', async () => {
    const { avatar, emit, handlers } = await setup();
    emit('state', { surfaces: { another: { data: { status: 'speaking' } } } });
    expect(avatar.setState).not.toHaveBeenCalled();
    handlers.get('speech_state')?.({ data: '<invalid>' });
    expect(avatar.followHost).not.toHaveBeenCalled();
    emit('state', { surfaces: { 'presence-studio': { data: { status: 'speaking' } } } });
    expect(avatar.setState).toHaveBeenLastCalledWith('idle');
    expect(avatar.followHost).not.toHaveBeenCalled();
    emit('state', { surfaces: { 'presence-studio': { data: { status: 'listening' } } } });
    expect(avatar.setState).toHaveBeenLastCalledWith('listening');
  });
  it('closes the stream and renderer exactly once; ignores late events', async () => {
    const { avatar, emit, close, dispose } = await setup();
    dispose();
    dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(avatar.dispose).toHaveBeenCalledOnce();
    avatar.followHost.mockClear();
    emit('speech_state', { status: 'speaking' });
    expect(avatar.followHost).not.toHaveBeenCalled();
  });
});
