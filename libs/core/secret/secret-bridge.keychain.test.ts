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
    mocks.safeWriteFile.mockReset();
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

  it('replaces via the trusted reader, then adds with a reader ACL and no secret-bearing argv', async () => {
    const removeChild = createFakeChild();
    const writeChild = createFakeChild();
    mocks.spawn.mockReturnValueOnce(removeChild).mockReturnValueOnce(writeChild);
    const pending = new MacKeychainSecretProvider().set('svc', 'acct', 'synthetic-new-value');
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawn.mock.calls[0][0]).toBe('security');
    expect(mocks.spawn.mock.calls[0][1]).toEqual([
      'delete-generic-password',
      '-a',
      'acct',
      '-s',
      'svc',
    ]);
    removeChild.emit('close', 44);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
    expect(mocks.spawn.mock.calls[1][0]).toBe('swift');
    const args: string[] = mocks.spawn.mock.calls[1][1];
    const script = args[args.indexOf('-e') + 1];
    expect(script).toContain(
      'SecTrustedApplicationCreateFromPath("/usr/bin/security", &trustedReader)'
    );
    expect(script).toContain(
      'SecAccessCreate(service as CFString, [reader] as CFArray, &accessRef)'
    );
    expect(script).toContain('add[kSecAttrAccess as String] = access');
    // SecItemUpdate keeps an existing item's ACL, so a duplicate is replaced.
    expect(script).not.toContain('SecItemUpdate');
    expect(script).toMatch(/errSecDuplicateItem[\s\S]*SecItemDelete[\s\S]*SecItemAdd/);
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain('synthetic-new-value');
    expect(writeChild.stdin.write).toHaveBeenCalledWith('svc\nacct\nsynthetic-new-value');
    writeChild.emit('close', 0);
    await expect(pending).resolves.toBeUndefined();
    expect(mocks.safeWriteFile).toHaveBeenCalledOnce();
  });

  it('leaves the entry and registry untouched when the existing item cannot be removed', async () => {
    const removeChild = createFakeChild();
    mocks.spawn.mockReturnValueOnce(removeChild);
    const pending = new MacKeychainSecretProvider().set('svc', 'acct', 'synthetic-new-value');
    const assertion = expect(pending).rejects.toThrow('entry unchanged');
    removeChild.emit('close', 128);
    await assertion;
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.safeWriteFile).not.toHaveBeenCalled();
  });

  it('reports that the previous entry was removed when the add fails', async () => {
    const removeChild = createFakeChild();
    const writeChild = createFakeChild();
    mocks.spawn.mockReturnValueOnce(removeChild).mockReturnValueOnce(writeChild);
    const pending = new MacKeychainSecretProvider().set('svc', 'acct', 'synthetic-new-value');
    const assertion = expect(pending).rejects.toThrow(/code 7 \(any previous entry was removed/);
    removeChild.emit('close', 0);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
    writeChild.emit('close', 7);
    await assertion;
    expect(mocks.safeWriteFile).not.toHaveBeenCalled();
  });

  it('does not remove the registry or retry when deletion is refused', async () => {
    const child = createFakeChild();
    mocks.spawn.mockReturnValue(child);
    const pending = new MacKeychainSecretProvider().delete('svc', 'acct');
    const assertion = expect(pending).rejects.toThrow('refused');
    child.emit('close', 51);
    await assertion;
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.safeWriteFile).not.toHaveBeenCalled();
  });

  it('rejects registry removal errors instead of throwing from the child callback', async () => {
    const child = createFakeChild();
    mocks.spawn.mockReturnValue(child);
    mocks.safeWriteFile.mockImplementation(() => {
      throw new Error('registry write denied');
    });
    const pending = new MacKeychainSecretProvider().delete('svc', 'acct');
    const assertion = expect(pending).rejects.toThrow('registry write denied');
    expect(() => child.emit('close', 0)).not.toThrow();
    await assertion;
  });

  it('rejects registry addition errors instead of throwing from the child callback', async () => {
    mocks.safeWriteFile.mockImplementationOnce(() => {
      throw new Error('registry write denied');
    });
    mocks.spawn.mockImplementation(() => {
      const child = createFakeChild();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    await expect(new MacKeychainSecretProvider().set('svc', 'acct', 'test-value')).rejects.toThrow(
      'registry write denied'
    );
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
    const removeChild = createFakeChild();
    const writeChild = createFakeChild();
    mocks.spawn.mockReturnValueOnce(removeChild).mockReturnValueOnce(writeChild);
    const provider = new MacKeychainSecretProvider();
    const pending = provider.set('svc', 'acct', 'value');
    const assertion = expect(pending).rejects.toThrow(
      `macOS Keychain write failed: timed out after ${KEYCHAIN_WRITE_TIMEOUT_MS}ms`
    );
    removeChild.emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeChild.stdin.write).toHaveBeenCalledWith('svc\nacct\nvalue');
    expect(writeChild.stdin.end).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KEYCHAIN_WRITE_TIMEOUT_MS);
    expect(writeChild.kill).toHaveBeenCalledWith('SIGKILL');
    await assertion;
  });
});
