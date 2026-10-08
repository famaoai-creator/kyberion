/**
 * G12: macOS keychain children are supervised — a spawn 'error' (missing
 * `security`/`swift`) resolves/rejects cleanly instead of crashing the
 * process, and a hung child (locked keychain prompt) is killed at a bound.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  safeWriteFile: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn };
});

// set()/delete() update the keychain registry under the live vault; keep the
// test hermetic by turning that write into a recorded no-op.
vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  return { ...actual, safeWriteFile: mocks.safeWriteFile, safeMkdir: vi.fn() };
});

import {
  KEYCHAIN_COMMAND_TIMEOUT_MS,
  KEYCHAIN_WRITE_TIMEOUT_MS,
  MacKeychainSecretProvider,
} from './secret-bridge.js';

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  child.kill = vi.fn();
  return child;
}

describe('MacKeychainSecretProvider child supervision (G12)', () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the secret on a clean exit', async () => {
    const child = createFakeChild();
    mocks.spawn.mockReturnValue(child);
    const pending = new MacKeychainSecretProvider().get('svc', 'acct');
    child.stdout.emit('data', 'sekret\n');
    child.emit('close', 0);
    await expect(pending).resolves.toBe('sekret');
  });

  it("resolves null instead of crashing when 'security' cannot be spawned", async () => {
    const child = createFakeChild();
    mocks.spawn.mockReturnValue(child);
    const pending = new MacKeychainSecretProvider().get('svc', 'acct');
    child.emit('error', new Error('spawn security ENOENT'));
    await expect(pending).resolves.toBeNull();
  });

  it('kills a hung keychain read after the bound and resolves null', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    mocks.spawn.mockReturnValue(child);
    const pending = new MacKeychainSecretProvider().get('svc', 'acct');
    await vi.advanceTimersByTimeAsync(KEYCHAIN_COMMAND_TIMEOUT_MS);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(pending).resolves.toBeNull();
    expect(KEYCHAIN_COMMAND_TIMEOUT_MS).toBe(10_000);
  });

  it('rejects a hung swift write after its bound (stdin still piped)', async () => {
    vi.useFakeTimers();
    const deleteChild = createFakeChild();
    const writeChild = createFakeChild();
    mocks.spawn.mockReturnValueOnce(deleteChild).mockReturnValueOnce(writeChild);
    const provider = new MacKeychainSecretProvider();
    const pending = provider.set('svc', 'acct', 'value');
    const assertion = expect(pending).rejects.toThrow(
      `macOS Keychain write failed: timed out after ${KEYCHAIN_WRITE_TIMEOUT_MS}ms`
    );
    // The delete step must not hang the write either: let it time out too.
    await vi.advanceTimersByTimeAsync(KEYCHAIN_COMMAND_TIMEOUT_MS);
    expect(deleteChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(writeChild.stdin.write).toHaveBeenCalledWith('svc\nacct\nvalue');
    expect(writeChild.stdin.end).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KEYCHAIN_WRITE_TIMEOUT_MS);
    expect(writeChild.kill).toHaveBeenCalledWith('SIGKILL');
    await assertion;
  });
});
