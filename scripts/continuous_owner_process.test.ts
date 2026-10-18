import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn() }));
vi.mock('@agent/core/managed-process', () => ({
  spawnManagedProcess: mocks.spawn,
  stopManagedProcess: mocks.stop,
}));
vi.mock('@agent/core/secure-io', () => ({
  buildSafeExecEnv: (env: Record<string, string>) => env,
}));
vi.mock('@agent/core/tool/runtime-supervisor', () => ({
  runtimeSupervisor: { register: vi.fn(), update: vi.fn() },
}));
vi.mock('@agent/core/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { runContinuousOwnerProcess } from './continuous_owner_process.js';
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue({ child, resourceId: 'resource' });
  return child;
}
const options = {
  cwd: '/repo',
  env: { KYBERION_TENANT: 'acme', KYBERION_ORGANIZATION_ID: 'org' },
  timeoutMs: 1000,
  maxOutputMB: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('continuous owner managed controller', () => {
  it.skipIf(process.platform !== 'win32')(
    'cleans up a worker after its Windows Job Object controller exits successfully',
    async () => {
      vi.mocked(process.kill).mockRestore();
      const actual = await vi.importActual<typeof import('@agent/core/managed-process')>(
        '@agent/core/managed-process'
      );
      mocks.spawn.mockImplementationOnce((spec) => actual.spawnManagedProcess(spec));
      const script =
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);child.unref();";
      const result = await runContinuousOwnerProcess(process.execPath, ['-e', script], {
        ...options,
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 10000,
      });
      expect(result).toMatchObject({ status: 0 });
      expect(result.error).toBeUndefined();
      let descendantPid: number | undefined = Number(result.stdout.trim());
      expect(descendantPid, JSON.stringify(result)).toBeGreaterThan(0);
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          process.kill(descendantPid!, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            descendantPid = undefined;
            break;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(descendantPid).toBeUndefined();
    },
    15000
  );
  it.skipIf(process.platform !== 'win32')(
    'terminates a Windows Job Object controller and its worker descendant on abort',
    async () => {
      vi.mocked(process.kill).mockRestore();
      const actual = await vi.importActual<typeof import('@agent/core/managed-process')>(
        '@agent/core/managed-process'
      );
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      let descendantPid: number | undefined;
      let wrapperStderr = '';
      mocks.spawn.mockImplementationOnce((spec) => {
        const handle = actual.spawnManagedProcess(spec);
        handle.child.stdout?.on('data', (chunk: Buffer) => {
          const parsed = Number(String(chunk).match(/\d+/)?.[0]);
          if (Number.isSafeInteger(parsed) && parsed > 0 && !descendantPid) {
            descendantPid = parsed;
            readyResolve();
          }
        });
        handle.child.stderr?.on('data', (chunk: Buffer) => {
          wrapperStderr += String(chunk);
        });
        return handle;
      });
      const abort = new AbortController();
      const script =
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);";
      const promise = runContinuousOwnerProcess(process.execPath, ['-e', script], {
        ...options,
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 10000,
        signal: abort.signal,
      });
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('descendant did not start: ' + wrapperStderr)), 5000)
          ),
        ]);
        expect(descendantPid).toBeGreaterThan(0);
        abort.abort();
        expect((await promise).error?.message).toContain('aborted');
        for (let attempt = 0; attempt < 150; attempt++) {
          try {
            process.kill(descendantPid!, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              descendantPid = undefined;
              break;
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(descendantPid).toBeUndefined();
      } finally {
        abort.abort();
        await promise;
      }
    },
    20000
  );
  it.skipIf(process.platform === 'win32')(
    'cleans up a worker after its controller exits successfully',
    async () => {
      vi.mocked(process.kill).mockRestore();
      const actual = await vi.importActual<typeof import('@agent/core/managed-process')>(
        '@agent/core/managed-process'
      );
      let parentPid: number | undefined;
      mocks.spawn.mockImplementationOnce((spec) => {
        const handle = actual.spawnManagedProcess(spec);
        parentPid = handle.child.pid;
        return handle;
      });
      const script =
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);child.unref();";
      let descendantPid: number | undefined;
      try {
        const result = await runContinuousOwnerProcess(process.execPath, ['-e', script], {
          ...options,
          cwd: process.cwd(),
          env: { ...process.env },
          timeoutMs: 5000,
        });
        expect(result).toMatchObject({ status: 0 });
        expect(result.error).toBeUndefined();
        descendantPid = Number(result.stdout.trim());
        expect(descendantPid).toBeGreaterThan(0);
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(descendantPid!, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              descendantPid = undefined;
              break;
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(descendantPid).toBeUndefined();
      } finally {
        if (parentPid)
          try {
            process.kill(-parentPid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
      }
    },
    10000
  );
  it('does not report success when normal-close descendant cleanup fails', async () => {
    const child = fixture();
    vi.mocked(process.kill).mockImplementationOnce(() => {
      throw Object.assign(new Error('cannot terminate descendants'), { code: 'EPERM' });
    });
    const promise = runContinuousOwnerProcess('node', [], options);
    child.emit('close', 0);
    expect(await promise).toMatchObject({
      status: 0,
      error: expect.objectContaining({ message: 'cannot terminate descendants' }),
    });
  });
  it.skipIf(process.platform === 'win32')(
    'aborts an actual controller and its worker descendant',
    async () => {
      vi.mocked(process.kill).mockRestore();
      const actual = await vi.importActual<typeof import('@agent/core/managed-process')>(
        '@agent/core/managed-process'
      );
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      let descendantPid: number | undefined;
      let parentPid: number | undefined;
      mocks.spawn.mockImplementationOnce((spec) => {
        const handle = actual.spawnManagedProcess(spec);
        parentPid = handle.child.pid;
        handle.child.stdout?.on('data', (chunk: Buffer) => {
          const parsed = Number(String(chunk).trim());
          if (Number.isSafeInteger(parsed) && parsed > 0) {
            descendantPid = parsed;
            readyResolve();
          }
        });
        return handle;
      });
      const abort = new AbortController();
      const script =
        "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid);setInterval(()=>{},1000);";
      const promise = runContinuousOwnerProcess(process.execPath, ['-e', script], {
        ...options,
        cwd: process.cwd(),
        env: { ...process.env },
        timeoutMs: 5000,
        signal: abort.signal,
      });
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('descendant did not start')), 3000)
          ),
        ]);
        expect(descendantPid).toBeGreaterThan(0);
        abort.abort();
        expect((await promise).error?.message).toContain('aborted');
        // Reparented children may briefly remain as zombies until the OS reaps them.
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(descendantPid!, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              descendantPid = undefined;
              break;
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(descendantPid).toBeUndefined();
        expect(() => process.kill(parentPid!, 0)).toThrow();
      } finally {
        abort.abort();
        if (parentPid)
          try {
            process.kill(-parentPid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        await promise;
      }
    },
    10000
  );
  it('ignores an already exited group but retains other group-kill errors', async () => {
    for (const code of ['ESRCH', 'EPERM']) {
      const child = fixture(),
        abort = new AbortController();
      vi.mocked(process.kill).mockImplementationOnce(() => {
        throw Object.assign(new Error(code), { code });
      });
      const promise = runContinuousOwnerProcess('node', [], { ...options, signal: abort.signal });
      abort.abort();
      child.emit('close', null);
      expect((await promise).error?.message).toBe(
        code === 'ESRCH' ? 'Continuous owner controller aborted' : 'EPERM'
      );
    }
  });
  it('does not spawn for an already aborted owner', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      runContinuousOwnerProcess('node', [], { ...options, signal: abort.signal })
    ).rejects.toThrow('aborted');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('passes cancellation and hard kill to the supervised child and waits for close', async () => {
    const child = fixture(),
      abort = new AbortController();
    const promise = runContinuousOwnerProcess('node', ['controller'], {
      ...options,
      signal: abort.signal,
    });
    expect(mocks.spawn.mock.calls[0]![0]).toMatchObject({
      spawnOptions: { detached: true, shell: false },
      metadata: { tenant_slug: 'acme', organization_id: 'org' },
    });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    abort.abort();
    expect(process.kill).toHaveBeenCalledWith(-123, 'SIGKILL');
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', null);
    expect((await promise).error?.message).toContain('aborted');
    expect(mocks.stop).toHaveBeenCalledWith(expect.stringContaining('continuous-owner:'), null);
  });
  it('collects bounded output and reports successful exit', async () => {
    const child = fixture();
    const promise = runContinuousOwnerProcess('node', [], options);
    child.stdout.emit('data', Buffer.from('ok'));
    child.stderr.emit('data', Buffer.from('diagnostic'));
    child.emit('close', 0);
    expect(await promise).toEqual({ status: 0, stdout: 'ok', stderr: 'diagnostic' });
  });
  it('kills the process at the command deadline and waits for settlement', async () => {
    vi.useFakeTimers();
    const child = fixture();
    const promise = runContinuousOwnerProcess('node', [], options);
    await vi.advanceTimersByTimeAsync(1000);
    expect(process.kill).toHaveBeenCalledWith(-123, 'SIGKILL');
    child.emit('close', null);
    expect((await promise).error?.message).toContain('deadline');
  });
  it('kills on output overflow and does not retain overflowing data', async () => {
    const child = fixture();
    const promise = runContinuousOwnerProcess('node', [], { ...options, maxOutputMB: 0.000001 });
    child.stdout.emit('data', Buffer.from('too much data'));
    expect(process.kill).toHaveBeenCalledWith(-123, 'SIGKILL');
    child.emit('close', null);
    expect(await promise).toMatchObject({ stdout: '', error: expect.any(Error) });
  });
  it('unregisters a child that failed before obtaining a pid', async () => {
    const child = fixture();
    Object.assign(child, { pid: undefined });
    const promise = runContinuousOwnerProcess('node', [], options);
    child.emit('error', new Error('spawn failed'));
    expect((await promise).error?.message).toBe('spawn failed');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
});
