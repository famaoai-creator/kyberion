import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHiddenToken } from './hidden-token-input.js';

class Terminal extends PassThrough {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  setRawMode(raw: boolean) {
    this.isRaw = raw;
    this.rawModes.push(raw);
    return this;
  }
}
function fixture() {
  const input = new Terminal();
  input.pause();
  const output = { isTTY: true, write: vi.fn(() => true) };
  const signals = new EventEmitter();
  const options = { input, output, signals, timeoutMs: 100 };
  const clean = () => {
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    for (const event of ['data', 'end', 'close', 'error'])
      expect(input.listenerCount(event)).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  };
  return { ...options, options, clean };
}
afterEach(() => vi.useRealTimers());
describe('hidden token input', () => {
  it('does not echo bytes and restores the terminal after confirmed input', async () => {
    const f = fixture();
    const result = readHiddenToken('Token: ', f.options);
    f.input.emit('data', Buffer.from('synthetic-token\r'));
    expect(await result).toBe('synthetic-token');
    expect(f.output.write.mock.calls).toEqual([['Token: '], ['\n']]);
    expect(f.input.rawModes).toEqual([true, false]);
    f.clean();
  });
  it.each(['\u0003', '\u0004', '\u001b'])(
    'rejects control input without exposing partial values (%j)',
    async (control) => {
      const f = fixture();
      const result = readHiddenToken('Token: ', f.options);
      f.input.emit('data', Buffer.from('partial-secret' + control));
      await expect(result).rejects.toThrow(/cancelled|ended|control/);
      expect(JSON.stringify(f.output.write.mock.calls)).not.toContain('partial-secret');
      f.clean();
    }
  );
  it.each(['end', 'close', 'error'])('restores on stream %s', async (event) => {
    const f = fixture();
    const result = readHiddenToken('Token: ', f.options);
    f.input.emit(event, new Error('must-not-echo'));
    await expect(result).rejects.toThrow(/ended|failed/);
    expect(JSON.stringify(f.output.write.mock.calls)).not.toContain('must-not-echo');
    f.clean();
  });
  it('times out and removes every listener', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = readHiddenToken('Token: ', f.options);
    const rejected = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    f.clean();
  });
  it('bounds bytes rather than code units, including split UTF-8 input', async () => {
    const f = fixture();
    const result = readHiddenToken('Token: ', { ...f.options, maxBytes: 3 });
    const token = Buffer.from('éé');
    f.input.emit('data', token.subarray(0, 1));
    f.input.emit('data', token.subarray(1));
    await expect(result).rejects.toThrow('size limit');
    f.clean();
  });
  it('supports backspace without writing the removed or retained value', async () => {
    const f = fixture();
    const result = readHiddenToken('Token: ', f.options);
    f.input.emit('data', Buffer.from('aé\u007fb\n'));
    expect(await result).toBe('ab');
    expect(f.output.write.mock.calls).toEqual([['Token: '], ['\n']]);
    f.clean();
  });
  it('preserves an already raw terminal and cancels on process signals', async () => {
    const f = fixture();
    f.input.isRaw = true;
    const result = readHiddenToken('Token: ', f.options);
    f.signals.emit('SIGTERM');
    await expect(result).rejects.toThrow('cancelled');
    expect(f.input.rawModes).toEqual([true, true]);
    expect(f.input.listenerCount('data')).toBe(0);
  });
  it('refuses non-TTY and concurrent readers before changing terminal state', async () => {
    const f = fixture();
    f.output.isTTY = false;
    await expect(readHiddenToken('Token: ', f.options)).rejects.toThrow('interactive terminal');
    f.output.isTTY = true;
    f.input.on('data', () => undefined);
    await expect(readHiddenToken('Token: ', f.options)).rejects.toThrow('already in use');
    expect(f.input.rawModes).toEqual([]);
    expect(f.output.write).not.toHaveBeenCalled();
  });
  it('rejects empty values and invalid collector limits', async () => {
    const f = fixture();
    await expect(readHiddenToken('Token: ', { ...f.options, timeoutMs: Infinity })).rejects.toThrow(
      'limits'
    );
    const result = readHiddenToken('Token: ', f.options);
    f.input.emit('data', '\r');
    await expect(result).rejects.toThrow('Empty token');
    f.clean();
  });
});
