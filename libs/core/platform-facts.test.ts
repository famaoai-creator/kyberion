import { afterEach, describe, expect, it } from 'vitest';
import {
  commandStringInvocation,
  executableName,
  getPlatformFacts,
  homeEnvVars,
  hostNodePlatform,
  hostPlatform,
  isMacOS,
  locateCommandInvocation,
  normalizePathForPlatformCompare,
  platformFacts,
  venvPythonCandidates,
  type PlatformFacts,
} from './platform-facts.js';

const PLATFORMS = ['darwin', 'win32', 'linux', 'unknown'] as const;

describe('getPlatformFacts', () => {
  it('returns a descriptor for every normalized platform', () => {
    for (const platform of PLATFORMS) {
      const facts = getPlatformFacts(platform);
      expect(facts.platform).toBe(platform);
    }
  });

  it('normalizes raw platform strings and unknown values', () => {
    expect(getPlatformFacts('darwin').platform).toBe('darwin');
    expect(getPlatformFacts('freebsd').platform).toBe('unknown');
    expect(getPlatformFacts('sunos').platform).toBe('unknown');
  });

  it('returns the same frozen descriptor object per platform', () => {
    expect(getPlatformFacts('darwin')).toBe(getPlatformFacts('darwin'));
    expect(Object.isFrozen(getPlatformFacts('win32'))).toBe(true);
    expect(Object.isFrozen(getPlatformFacts('win32').commands)).toBe(true);
    expect(Object.isFrozen(getPlatformFacts('win32').layout.venvPythonNames)).toBe(true);
  });

  it('maps platforms to the windows/posix family', () => {
    expect(getPlatformFacts('win32').family).toBe('windows');
    expect(getPlatformFacts('darwin').family).toBe('posix');
    expect(getPlatformFacts('linux').family).toBe('posix');
    expect(getPlatformFacts('unknown').family).toBe('posix');
  });

  it('marks Apple capability surface as darwin-only', () => {
    for (const platform of PLATFORMS) {
      const facts = getPlatformFacts(platform);
      expect(facts.capabilities.appleAutomation).toBe(platform === 'darwin');
      expect(facts.capabilities.appleSpeech).toBe(platform === 'darwin');
    }
  });
});

describe('platformFacts', () => {
  it('describes the current host', () => {
    expect(platformFacts.platform).toBe(getPlatformFacts(process.platform).platform);
  });
});

describe('executableName', () => {
  it('appends .exe only on Windows', () => {
    expect(executableName('pnpm', getPlatformFacts('win32'))).toBe('pnpm.exe');
    expect(executableName('pnpm', getPlatformFacts('darwin'))).toBe('pnpm');
    expect(executableName('adb', getPlatformFacts('linux'))).toBe('adb');
  });
});

describe('locateCommandInvocation', () => {
  it('produces where on Windows and which on POSIX', () => {
    expect(locateCommandInvocation('node', getPlatformFacts('win32'))).toEqual(['where', 'node']);
    expect(locateCommandInvocation('node', getPlatformFacts('darwin'))).toEqual(['which', 'node']);
    expect(locateCommandInvocation('node', getPlatformFacts('linux'))).toEqual(['which', 'node']);
  });

  it('adds the all-matches flag only when requested', () => {
    expect(locateCommandInvocation('node', getPlatformFacts('darwin'), { all: true })).toEqual([
      'which',
      '-a',
      'node',
    ]);
    expect(locateCommandInvocation('node', getPlatformFacts('linux'), { all: true })).toEqual([
      'which',
      '-a',
      'node',
    ]);
    // `where` already lists every PATH match — no extra flag exists.
    expect(locateCommandInvocation('node', getPlatformFacts('win32'), { all: true })).toEqual([
      'where',
      'node',
    ]);
  });
});

describe('host platform reads', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: hostNodePlatform() });
  });

  it('honor the Object.defineProperty(process, "platform") test stub', () => {
    const real = hostNodePlatform();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(hostPlatform()).toBe('linux');
    expect(hostNodePlatform()).toBe('linux');
    expect(isMacOS()).toBe(false);
    Object.defineProperty(process, 'platform', { value: real });
  });
});

describe('commandStringInvocation', () => {
  it('routes command strings through cmd.exe or /bin/sh', () => {
    expect(commandStringInvocation('echo hi', getPlatformFacts('win32'))).toEqual([
      'cmd.exe',
      '/d',
      '/s',
      '/c',
      'echo hi',
    ]);
    expect(commandStringInvocation('echo hi', getPlatformFacts('linux'))).toEqual([
      '/bin/sh',
      '-c',
      'echo hi',
    ]);
  });
});

describe('venvPythonCandidates', () => {
  it('maps the venv layout per platform', () => {
    expect(venvPythonCandidates('/env', getPlatformFacts('win32'))).toEqual([
      '/env/Scripts/python.exe',
      '/env/Scripts/python3.exe',
    ]);
    expect(venvPythonCandidates('/env', getPlatformFacts('linux'))).toEqual([
      '/env/bin/python',
      '/env/bin/python3',
    ]);
  });
});

describe('normalizePathForPlatformCompare', () => {
  it('lowercases on case-insensitive platforms only', () => {
    expect(normalizePathForPlatformCompare('AbC/Def', getPlatformFacts('win32'))).toBe('abc/def');
    expect(normalizePathForPlatformCompare('AbC/Def', getPlatformFacts('darwin'))).toBe('abc/def');
    expect(normalizePathForPlatformCompare('AbC/Def', getPlatformFacts('linux'))).toBe('AbC/Def');
  });
});

describe('homeEnvVars', () => {
  it('exposes USERPROFILE on Windows and HOME on POSIX', () => {
    expect(homeEnvVars(getPlatformFacts('win32'))).toEqual(['USERPROFILE']);
    expect(homeEnvVars(getPlatformFacts('darwin'))).toEqual(['HOME']);
  });
});

describe('facts descriptor shape', () => {
  const requiredKeys: Array<keyof PlatformFacts> = [
    'platform',
    'family',
    'executables',
    'commands',
    'layout',
    'env',
    'filesystem',
    'ipc',
    'processModel',
    'media',
    'capabilities',
  ];

  it.each(PLATFORMS)('exposes the full descriptor for %s', (platform) => {
    const facts = getPlatformFacts(platform);
    for (const key of requiredKeys) expect(facts[key]).toBeDefined();
  });

  it('uses a named pipe only on Windows', () => {
    expect(getPlatformFacts('win32').ipc.kind).toBe('named-pipe');
    expect(getPlatformFacts('win32').ipc.namedPipePrefix).toBe('\\\\.\\pipe\\');
    expect(getPlatformFacts('darwin').ipc.kind).toBe('unix-socket');
    expect(getPlatformFacts('linux').ipc.namedPipePrefix).toBe('');
  });

  it('reports POSIX process semantics only on POSIX platforms', () => {
    expect(getPlatformFacts('win32').processModel.hasProcessGroups).toBe(false);
    expect(getPlatformFacts('darwin').processModel.hasProcessGroups).toBe(true);
    expect(getPlatformFacts('linux').processModel.hasPosixSignals).toBe(true);
  });
});
