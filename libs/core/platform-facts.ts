import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Platform Facts Layer
 *
 * The nouns of platform abstraction. `platform.ts` (OSDriver) covers the
 * verbs — captureScreen, speak, open — while the differences feature code
 * actually trips over are facts: executable suffixes, command names, venv
 * layouts, shell invocations, IPC transports, path case semantics, process
 * model. Without a canonical table, each call site reinvents them as inline
 * `process.platform === 'win32' ? … : …` ternaries (see
 * tests/platform-read-boundary.test.ts for the gate that keeps new code off
 * that path).
 *
 * Facts are a closed, declarative descriptor — pure data, no I/O, no
 * probing. Runtime capability detection stays in platform.ts
 * (getCapabilities) and the caller's own probes.
 */

export type PlatformFamily = 'windows' | 'posix';

/**
 * Normalized platform identity. Defined here (the leaf platform module) and
 * re-exported by platform.ts so the driver layer can depend on facts without
 * facts depending on drivers.
 */
export type Platform = 'darwin' | 'win32' | 'linux' | 'unknown';

/**
 * Normalize a raw `process.platform` / `os.platform()` value to the
 * closed Platform union. Unknown values collapse to 'unknown'.
 */
export function normalizePlatform(value: string): Platform {
  if (value === 'darwin' || value === 'win32' || value === 'linux') return value;
  return 'unknown';
}

/**
 * Pure, injectable OS predicates — prefer these over raw platform checks.
 * Defaults read `process.platform` (not `os.platform()`) so the established
 * `Object.defineProperty(process, 'platform', …)` test stub keeps working.
 */
export function isMacOS(platform: string = process.platform): boolean {
  return normalizePlatform(platform) === 'darwin';
}

export function isWindows(platform: string = process.platform): boolean {
  return normalizePlatform(platform) === 'win32';
}

export function isLinux(platform: string = process.platform): boolean {
  return normalizePlatform(platform) === 'linux';
}

export function isAppleSilicon(
  platform: string = process.platform,
  arch: string = os.arch()
): boolean {
  return isMacOS(platform) && arch === 'arm64';
}

/**
 * Current host platform, read at call time. Use this — not a module-level
 * constant — wherever a branch must honor a platform stubbed after import.
 */
export function hostPlatform(): Platform {
  return normalizePlatform(process.platform);
}

/** Same as hostPlatform(), but typed `NodeJS.Platform` for Node-typed fields. */
export function hostNodePlatform(): NodeJS.Platform {
  return process.platform;
}

/** Process CPU architecture, read at call time (e.g. 'arm64', 'x64'). */
export function hostArch(): string {
  return os.arch();
}

export interface PlatformFacts {
  /** Normalized platform identity (see normalizePlatform). */
  readonly platform: Platform;
  /** The axis most guards actually mean: Windows vs POSIX semantics. */
  readonly family: PlatformFamily;
  readonly executables: {
    /** '.exe' on Windows, '' elsewhere. */
    readonly suffix: '' | '.exe';
  };
  readonly commands: {
    /** Locates a command on PATH: `where` (Windows) / `which -a` (POSIX). */
    readonly locate: {
      readonly command: 'where' | 'which';
      /** Extra args inserted before the target ('-a' on POSIX). */
      readonly allArgs: readonly string[];
    };
    /** Shell used to run an opaque command string. */
    readonly commandStringShell: {
      readonly executable: 'cmd.exe' | '/bin/sh';
      /** Args inserted before the command string itself. */
      readonly prefixArgs: readonly string[];
    };
    /** File-manager application label for UX copy. */
    readonly fileManagerApp: 'File Explorer' | 'Finder' | 'the file manager';
    /** Opens a path or URL with the OS default handler. */
    readonly open: 'explorer.exe' | 'open' | 'xdg-open';
  };
  readonly layout: {
    /** Virtualenv binary directory: 'Scripts' (Windows) / 'bin' (POSIX). */
    readonly venvBinDir: 'Scripts' | 'bin';
    /** Python executable names inside venvBinDir, in preference order. */
    readonly venvPythonNames: readonly string[];
    /**
     * Directory that holds site-packages inside a venv: 'Lib' (Windows,
     * flat) / 'lib' (POSIX, pythonX.Y subdirectories).
     */
    readonly venvLibDir: 'Lib' | 'lib';
  };
  readonly env: {
    /** Environment variables that hold the user's home directory. */
    readonly homeVars: readonly string[];
  };
  readonly filesystem: {
    /**
     * Default-volume paths compare case-insensitively (NTFS and default
     * APFS/HFS+). Use normalizePathForPlatformCompare for comparisons; never
     * store the lowered form.
     */
    readonly caseInsensitivePaths: boolean;
    /** fs.symlink() `type` argument for directory links. */
    readonly dirSymlinkType: 'junction' | 'dir';
  };
  readonly ipc: {
    readonly kind: 'named-pipe' | 'unix-socket';
    /** '\\\\.\\pipe\\' on Windows, '' elsewhere. */
    readonly namedPipePrefix: string;
  };
  readonly processModel: {
    /** Process groups / pgid semantics exist (POSIX). */
    readonly hasProcessGroups: boolean;
    /** POSIX signal semantics (SIGTERM graceful, SIGHUP, …); Windows is termination-only. */
    readonly hasPosixSignals: boolean;
  };
  readonly media: {
    /** Preferred container for lossless system audio capture. */
    readonly losslessAudioContainer: 'aiff' | 'wav';
  };
  readonly capabilities: {
    /** Apple automation surface: osascript / JXA / System Events. */
    readonly appleAutomation: boolean;
    /** `say` binary and Apple platform speech APIs. */
    readonly appleSpeech: boolean;
  };
}

/** Recursively freezes a descriptor so the shared table is truly immutable. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

const DARWIN_FACTS: PlatformFacts = deepFreeze({
  platform: 'darwin',
  family: 'posix',
  executables: { suffix: '' },
  commands: {
    locate: { command: 'which', allArgs: Object.freeze(['-a']) },
    commandStringShell: { executable: '/bin/sh', prefixArgs: Object.freeze(['-c']) },
    fileManagerApp: 'Finder',
    open: 'open',
  },
  layout: {
    venvBinDir: 'bin',
    venvPythonNames: Object.freeze(['python', 'python3']),
    venvLibDir: 'lib',
  },
  env: { homeVars: Object.freeze(['HOME']) },
  filesystem: { caseInsensitivePaths: true, dirSymlinkType: 'dir' },
  ipc: { kind: 'unix-socket', namedPipePrefix: '' },
  processModel: { hasProcessGroups: true, hasPosixSignals: true },
  media: { losslessAudioContainer: 'aiff' },
  capabilities: { appleAutomation: true, appleSpeech: true },
});

const WIN32_FACTS: PlatformFacts = deepFreeze({
  platform: 'win32',
  family: 'windows',
  executables: { suffix: '.exe' },
  commands: {
    locate: { command: 'where', allArgs: Object.freeze([]) },
    commandStringShell: {
      executable: 'cmd.exe',
      prefixArgs: Object.freeze(['/d', '/s', '/c']),
    },
    fileManagerApp: 'File Explorer',
    open: 'explorer.exe',
  },
  layout: {
    venvBinDir: 'Scripts',
    venvPythonNames: Object.freeze(['python.exe', 'python3.exe']),
    venvLibDir: 'Lib',
  },
  env: { homeVars: Object.freeze(['USERPROFILE']) },
  filesystem: { caseInsensitivePaths: true, dirSymlinkType: 'junction' },
  ipc: { kind: 'named-pipe', namedPipePrefix: '\\\\.\\pipe\\' },
  processModel: { hasProcessGroups: false, hasPosixSignals: false },
  media: { losslessAudioContainer: 'wav' },
  capabilities: { appleAutomation: false, appleSpeech: false },
});

const LINUX_FACTS: PlatformFacts = deepFreeze({
  platform: 'linux',
  family: 'posix',
  executables: { suffix: '' },
  commands: {
    locate: { command: 'which', allArgs: Object.freeze(['-a']) },
    commandStringShell: { executable: '/bin/sh', prefixArgs: Object.freeze(['-c']) },
    fileManagerApp: 'the file manager',
    open: 'xdg-open',
  },
  layout: {
    venvBinDir: 'bin',
    venvPythonNames: Object.freeze(['python', 'python3']),
    venvLibDir: 'lib',
  },
  env: { homeVars: Object.freeze(['HOME']) },
  filesystem: { caseInsensitivePaths: false, dirSymlinkType: 'dir' },
  ipc: { kind: 'unix-socket', namedPipePrefix: '' },
  processModel: { hasProcessGroups: true, hasPosixSignals: true },
  media: { losslessAudioContainer: 'wav' },
  capabilities: { appleAutomation: false, appleSpeech: false },
});

// Unknown platforms take POSIX-family defaults — the conservative shape that
// degrades like the Linux driver rather than guessing Windows semantics.
const UNKNOWN_FACTS: PlatformFacts = deepFreeze({
  ...LINUX_FACTS,
  platform: 'unknown',
});

const FACTS_BY_PLATFORM: Readonly<Record<Platform, PlatformFacts>> = deepFreeze({
  darwin: DARWIN_FACTS,
  win32: WIN32_FACTS,
  linux: LINUX_FACTS,
  unknown: UNKNOWN_FACTS,
});

/**
 * Returns the declarative facts descriptor for a platform. Accepts any raw
 * `process.platform` / `os.platform()` value; unknown values normalize to
 * 'unknown'. The result is a shared frozen object — do not mutate.
 */
export function getPlatformFacts(platform: string = process.platform): PlatformFacts {
  return FACTS_BY_PLATFORM[normalizePlatform(platform)];
}

/**
 * Facts for the current host, snapshotted at module load. Functions that
 * take an injected `platform` must call getPlatformFacts(platform) instead —
 * the snapshot cannot see a platform stubbed after import.
 */
export const platformFacts: PlatformFacts = getPlatformFacts();

/** 'pnpm' → 'pnpm.exe' on Windows, 'pnpm' elsewhere. */
export function executableName(base: string, facts: PlatformFacts = platformFacts): string {
  return `${base}${facts.executables.suffix}`;
}

/**
 * Full argv for locating a command on PATH. `all: true` asks for every match
 * (`which -a` / `where`) for callers that iterate PATH candidates; the
 * default reproduces the plain `which t` / `where t` probe contract.
 */
export function locateCommandInvocation(
  target: string,
  facts: PlatformFacts = platformFacts,
  options: { all?: boolean } = {}
): string[] {
  return [
    facts.commands.locate.command,
    ...(options.all ? facts.commands.locate.allArgs : []),
    target,
  ];
}

/** Full argv for running an opaque command string through the OS shell. */
export function commandStringInvocation(
  command: string,
  facts: PlatformFacts = platformFacts
): string[] {
  return [
    facts.commands.commandStringShell.executable,
    ...facts.commands.commandStringShell.prefixArgs,
    command,
  ];
}

/** Ordered candidate paths for the managed-venv python binary. */
export function venvPythonCandidates(
  envDir: string,
  facts: PlatformFacts = platformFacts
): string[] {
  return facts.layout.venvPythonNames.map((name) =>
    path.join(envDir, facts.layout.venvBinDir, name)
  );
}

/**
 * Canonical form for path comparisons on the current filesystem semantics.
 * Lowercases on case-insensitive platforms; for comparisons only — never
 * store the returned form.
 */
export function normalizePathForPlatformCompare(
  filePath: string,
  facts: PlatformFacts = platformFacts
): string {
  return facts.filesystem.caseInsensitivePaths ? filePath.toLowerCase() : filePath;
}

/** Environment variables that carry the user's home directory. */
export function homeEnvVars(facts: PlatformFacts = platformFacts): readonly string[] {
  return facts.env.homeVars;
}
