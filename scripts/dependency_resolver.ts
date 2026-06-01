#!/usr/bin/env node
/**
 * Dependency Resolver — Phase A-3 (on-demand pull)
 *
 * Provides runtime-level dependency checking for actuators. Called before
 * an actuator spins up to confirm its required binaries, services, and
 * packages are present — and optionally installs or guides the user.
 *
 * Three resolution levels:
 *   must   — actuator cannot run without this; block with install prompt
 *   should — actuator degrades without this; warn and continue in fallback mode
 *   nice   — optional enhancement; inform only
 *
 * Usage (programmatic):
 *   import { resolveDependencies, ACTUATOR_DEPS } from './dependency_resolver.js';
 *   const report = await resolveDependencies(ACTUATOR_DEPS.browser);
 *
 * Usage (CLI):
 *   pnpm tsx scripts/dependency_resolver.ts --actuator browser
 *   pnpm tsx scripts/dependency_resolver.ts --actuator voice --auto-install
 */

import { execSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getActuatorDependencyBundle, loadActuatorDependencyBundles, type ActuatorDependencyBundleEntry } from '@agent/core';

export type DependencyLevel = 'must' | 'should' | 'nice';
export type DependencyStatus = 'ok' | 'missing' | 'degraded';

export interface Dependency {
  id: string;
  name: string;
  level: DependencyLevel;
  /** Returns { ok, version?, detail? }. Should not throw. */
  check: () => Promise<{ ok: boolean; version?: string; detail?: string }>;
  /** Shell command to install. Omit if installation is manual. */
  installCommand?: string;
  /** Human-readable size hint, e.g. "200 MB, ~30s". */
  installSizeHint?: string;
  /** Describes the degraded mode when this dep is absent. */
  fallbackMode?: string;
}

export interface DependencyReport {
  id: string;
  name: string;
  level: DependencyLevel;
  status: DependencyStatus;
  version?: string;
  detail?: string;
  installCommand?: string;
  installSizeHint?: string;
  fallbackMode?: string;
}

export interface ResolutionResult {
  allMustsSatisfied: boolean;
  reports: DependencyReport[];
  mustMissing: DependencyReport[];
  shouldMissing: DependencyReport[];
  niceMissing: DependencyReport[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryExec(cmd: string): { ok: boolean; stdout: string } {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function checkBinary(binary: string): { ok: boolean; version?: string } {
  const result = tryExec(`${binary} --version`);
  if (result.ok) return { ok: true, version: result.stdout.split('\n')[0] };
  const which = tryExec(`which ${binary}`);
  return { ok: which.ok };
}

function checkPort(port: number, host = '127.0.0.1'): boolean {
  const result = spawnSync('nc', ['-z', '-w1', host, String(port)], { stdio: 'ignore' });
  return result.status === 0;
}

// ─── Built-in Dependency Definitions ─────────────────────────────────────────

const PLAYWRIGHT_BROWSER: Dependency = {
  id: 'playwright-browser',
  name: 'Playwright browser binaries',
  level: 'must',
  check: async () => {
    const result = tryExec('npx playwright --version');
    if (!result.ok) return { ok: false, detail: 'playwright CLI not found' };
    // Check if at least one browser binary exists
    const chromiumResult = tryExec('npx playwright install --dry-run chromium 2>&1');
    const alreadyInstalled = chromiumResult.stdout.includes('already installed') ||
      tryExec('ls "$(npx playwright install --dry-run chromium 2>&1 | grep -o \'/.*chromium[^\\n]*\')" 2>/dev/null').ok;
    return { ok: true, version: result.stdout, detail: alreadyInstalled ? 'installed' : 'may need install' };
  },
  installCommand: 'npx playwright install chromium',
  installSizeHint: '~200 MB, ~30s',
  fallbackMode: 'browser-actuator unavailable',
};

const PYTHON3: Dependency = {
  id: 'python3',
  name: 'Python 3.9+',
  level: 'must',
  check: async () => {
    const result = tryExec('python3 --version');
    if (!result.ok) return { ok: false, detail: 'python3 not in PATH' };
    const version = result.stdout.replace('Python ', '').trim();
    const [major, minor] = version.split('.').map(Number);
    if (major < 3 || (major === 3 && minor < 9)) {
      return { ok: false, version, detail: 'Python 3.9+ required' };
    }
    return { ok: true, version };
  },
  installCommand: 'brew install python@3.11  # macOS; use apt/dnf for Linux',
  fallbackMode: 'voice and whisper actuators unavailable',
};

const FFMPEG: Dependency = {
  id: 'ffmpeg',
  name: 'ffmpeg',
  level: 'should',
  check: async () => {
    const r = checkBinary('ffmpeg');
    return { ok: r.ok, version: r.version, detail: r.ok ? undefined : 'ffmpeg not in PATH' };
  },
  installCommand: 'brew install ffmpeg  # macOS; or apt install ffmpeg',
  installSizeHint: '~100 MB',
  fallbackMode: 'audio/video conversion degraded; media-generation limited',
};

const COMFYUI: Dependency = {
  id: 'comfyui-server',
  name: 'ComfyUI server (port 8188)',
  level: 'should',
  check: async () => {
    const ok = checkPort(8188);
    return { ok, detail: ok ? 'listening on :8188' : 'not reachable on localhost:8188' };
  },
  fallbackMode: 'image generation unavailable; use cloud API fallback',
};

const WHISPER: Dependency = {
  id: 'whisper',
  name: 'Whisper STT (faster-whisper or openai-whisper)',
  level: 'should',
  check: async () => {
    const r1 = checkBinary('whisper');
    if (r1.ok) return { ok: true, version: r1.version };
    const r2 = tryExec('python3 -c "import faster_whisper; print(faster_whisper.__version__)"');
    if (r2.ok) return { ok: true, version: `faster-whisper ${r2.stdout}` };
    return { ok: false, detail: 'neither whisper CLI nor faster_whisper python module found' };
  },
  installCommand: 'pip3 install faster-whisper',
  fallbackMode: 'voice transcription unavailable; use cloud STT',
};

const NATIVE_TTS: Dependency = {
  id: 'native-tts',
  name: 'OS native TTS (say / espeak / powershell)',
  level: 'must',
  check: async () => {
    const platform = process.platform;
    if (platform === 'darwin') {
      const r = tryExec('which say');
      return { ok: r.ok, version: 'macOS say', detail: r.ok ? undefined : 'say not found' };
    } else if (platform === 'linux') {
      const r = tryExec('which espeak');
      if (r.ok) return { ok: true, version: 'espeak' };
      const r2 = tryExec('which espeak-ng');
      return { ok: r2.ok, version: r2.ok ? 'espeak-ng' : undefined, detail: r2.ok ? undefined : 'espeak/espeak-ng not found' };
    } else if (platform === 'win32') {
      return { ok: true, version: 'Windows SAPI (powershell)' };
    }
    return { ok: false, detail: `unsupported platform: ${platform}` };
  },
  installCommand: 'sudo apt install espeak-ng  # Linux only',
  fallbackMode: 'voice output falls back to text-only',
};

const NODE22: Dependency = {
  id: 'node22',
  name: 'Node.js 22+',
  level: 'must',
  check: async () => {
    const r = checkBinary('node');
    if (!r.ok) return { ok: false, detail: 'node not in PATH' };
    const version = r.version?.replace('v', '') ?? '';
    const major = parseInt(version.split('.')[0] ?? '0', 10);
    if (major < 22) return { ok: false, version, detail: 'Node.js 22+ required' };
    return { ok: true, version };
  },
  installCommand: 'nvm install 22 && nvm use 22',
  fallbackMode: 'Kyberion will not build',
};

const PNPM: Dependency = {
  id: 'pnpm',
  name: 'pnpm',
  level: 'must',
  check: async () => {
    const r = checkBinary('pnpm');
    return { ok: r.ok, version: r.version, detail: r.ok ? undefined : 'pnpm not in PATH' };
  },
  installCommand: 'npm install -g pnpm',
};

const DEPENDENCY_BY_ID: Record<string, Dependency> = {
  node22: NODE22,
  pnpm: PNPM,
  python3: PYTHON3,
  'playwright-browser': PLAYWRIGHT_BROWSER,
  'native-tts': NATIVE_TTS,
  whisper: WHISPER,
  ffmpeg: FFMPEG,
  'comfyui-server': COMFYUI,
};

function buildDependenciesForBundle(bundle: ActuatorDependencyBundleEntry): Dependency[] {
  return bundle.dependency_ids.map((dependencyId) => {
    const dependency = DEPENDENCY_BY_ID[dependencyId];
    if (!dependency) throw new Error(`Unknown dependency id in actuator bundle: ${dependencyId}`);
    return dependency;
  });
}

// ─── Actuator Dep Bundles ─────────────────────────────────────────────────────

export const ACTUATOR_DEPS: Record<string, Dependency[]> = (() => {
  const bundles = loadActuatorDependencyBundles();
  const deps: Record<string, Dependency[]> = {};
  for (const bundle of bundles.bundles) {
    deps[bundle.actuator] = buildDependenciesForBundle(bundle);
  }
  if (!deps.all) {
    const allBundle = getActuatorDependencyBundle('all');
    if (allBundle) deps.all = buildDependenciesForBundle(allBundle);
  }
  return deps;
})();

// ─── Resolver ─────────────────────────────────────────────────────────────────

export async function resolveDependencies(deps: Dependency[]): Promise<ResolutionResult> {
  const reports: DependencyReport[] = [];

  for (const dep of deps) {
    let result: { ok: boolean; version?: string; detail?: string };
    try {
      result = await dep.check();
    } catch (err: unknown) {
      result = { ok: false, detail: String((err as Error).message ?? err) };
    }

    reports.push({
      id: dep.id,
      name: dep.name,
      level: dep.level,
      status: result.ok ? 'ok' : 'missing',
      version: result.version,
      detail: result.detail,
      installCommand: dep.installCommand,
      installSizeHint: dep.installSizeHint,
      fallbackMode: dep.fallbackMode,
    });
  }

  const mustMissing = reports.filter(r => r.level === 'must' && r.status !== 'ok');
  const shouldMissing = reports.filter(r => r.level === 'should' && r.status !== 'ok');
  const niceMissing = reports.filter(r => r.level === 'nice' && r.status !== 'ok');

  return { allMustsSatisfied: mustMissing.length === 0, reports, mustMissing, shouldMissing, niceMissing };
}

export function formatResolutionReport(result: ResolutionResult): string {
  const lines: string[] = [];
  const icon = (s: DependencyStatus) => s === 'ok' ? '✓' : '✗';
  const levelPad = (l: DependencyLevel) => l === 'must' ? 'MUST  ' : l === 'should' ? 'SHOULD' : 'NICE  ';

  for (const r of result.reports) {
    const status = `[${icon(r.status)}] ${levelPad(r.level)}  ${r.name}`;
    const version = r.version ? `  (${r.version})` : '';
    lines.push(status + version);
    if (r.status !== 'ok') {
      if (r.detail) lines.push(`         detail: ${r.detail}`);
      if (r.installCommand) {
        const hint = r.installSizeHint ? ` (${r.installSizeHint})` : '';
        lines.push(`         install: ${r.installCommand}${hint}`);
      }
      if (r.fallbackMode) lines.push(`         fallback: ${r.fallbackMode}`);
    }
  }

  if (!result.allMustsSatisfied) {
    lines.push('');
    lines.push(`⚠  ${result.mustMissing.length} must-have dep(s) missing — actuator cannot start.`);
  } else if (result.shouldMissing.length > 0) {
    lines.push('');
    lines.push(`⚡ ${result.shouldMissing.length} should-have dep(s) missing — running in degraded mode.`);
  } else {
    lines.push('');
    lines.push('✓ All required dependencies satisfied.');
  }

  return lines.join('\n');
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const actuatorIdx = args.indexOf('--actuator');
  const actuator = actuatorIdx >= 0 ? args[actuatorIdx + 1] : 'all';
  const jsonOutput = args.includes('--json');

  const deps = ACTUATOR_DEPS[actuator ?? 'all'];
  if (!deps) {
    console.error(`Unknown actuator: ${actuator}. Available: ${Object.keys(ACTUATOR_DEPS).join(', ')}`);
    process.exit(1);
  }

  const result = await resolveDependencies(deps);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nDependency check — actuator: ${actuator}\n`);
    console.log(formatResolutionReport(result));
  }

  process.exit(result.allMustsSatisfied ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
