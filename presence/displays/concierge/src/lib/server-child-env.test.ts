import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeReaddir, safeStat } from '@agent/core/secure-io';
import { governedWorkerEnv, serverChildEnv, serverDelegatedChildEnv } from './server-child-env';

const CONCIERGE_ROOT = pathResolver.rootResolve('presence/displays/concierge');
const SCAN_DIRS = ['src', 'server'];
// Built from parts so this scanner is not itself counted as a managed-process caller.
const SPAWN_NAMES = [
  'safeExec',
  'safeExecResult',
  'safeExecResultAsync',
  'safeSpawn',
  ['spawn', 'Managed', 'Process'].join(''),
  'spawnSync',
  'spawn',
  'execFileSync',
  'execFile',
  'fork',
];
const SPAWN_CALL = new RegExp(`\\b(${SPAWN_NAMES.join('|')})\\s*\\(`, 'g');
/** Builders that set an explicit, policy-bounded SYSTEM_ROLE (lib/server-child-env.ts). */
const BOUNDED_BUILDERS =
  /\b(serverChildEnv|serverDelegatedChildEnv|governedWorkerEnv|overviewChildEnv)\(/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry);
    if (safeStat(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next') out.push(...sources(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

/** The text between the call's parentheses. */
function callArguments(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return source.slice(openIndex + 1);
}

let scannedSites = 0;

/** Every spawn call site and whether its env is policy-bounded. */
export function unboundedSpawnSites(file: string, source: string): string[] {
  const findings: string[] = [];
  for (const match of source.matchAll(SPAWN_CALL)) {
    // `function spawn(` declarations are not spawn sites.
    if (/function\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
    const args = callArguments(source, match.index + match[0].length - 1);
    // A method signature inside a type (`safeExecResult(command: string, …)`).
    if (/^\s*\w+\??\s*:\s*[A-Za-z{[(]/.test(args)) continue;
    scannedSites += 1;
    const line = source.slice(0, match.index).split('\n').length;
    const site = `${path.relative(CONCIERGE_ROOT, file)}:${line} ${match[1]}`;
    const envMatch = args.match(/\benv\s*:\s*([^,\n}]+)|[{,]\s*env\s*[,}\n]/);
    if (!envMatch) {
      findings.push(`${site} (no env: the child would run without SYSTEM_ROLE)`);
      continue;
    }
    const expression = (envMatch[1] ?? 'env').trim();
    if (BOUNDED_BUILDERS.test(expression)) continue;
    const identifier = expression.match(/^[A-Za-z_$][\w$]*$/)?.[0];
    const declaration = identifier
      ? source.match(new RegExp(`\\b(?:const|let)\\s+${identifier}\\b[^=]*=\\s*([^;]+);`))
      : null;
    if (declaration && BOUNDED_BUILDERS.test(declaration[1] ?? '')) continue;
    findings.push(`${site} (env '${expression}' is not built by a bounded builder)`);
  }
  return findings;
}

describe('server child-process environments (H1)', () => {
  it('bounds every Concierge spawn by an explicit SYSTEM_ROLE', () => {
    const findings = SCAN_DIRS.flatMap((dir) => sources(path.join(CONCIERGE_ROOT, dir))).flatMap(
      (file) => unboundedSpawnSites(file, String(safeReadFile(file, { encoding: 'utf8' })))
    );
    expect(findings).toEqual([]);
    // The scan must actually see the server's spawn sites (routes, workers, facades).
    expect(scannedSites).toBeGreaterThanOrEqual(12);
  });

  it('flags a spawn without env or with an unbounded env', () => {
    expect(
      unboundedSpawnSites('/x.ts', "safeExec('node', ['dist/scripts/run_pipeline.js'], { cwd })")
    ).toHaveLength(1);
    expect(
      unboundedSpawnSites('/x.ts', "safeExecResult('pnpm', [], { env: process.env })")
    ).toHaveLength(1);
    expect(
      unboundedSpawnSites('/x.ts', "const env = serverChildEnv();\nsafeExec('pnpm', [], { env });")
    ).toEqual([]);
  });

  it('sets the server role, clears the launcher identity and sudo', () => {
    const env = serverChildEnv({ KYBERION_SUDO: 'true', MISSION_ROLE: 'sovereign' });
    expect(env).toMatchObject({
      SYSTEM_ROLE: 'concierge',
      MISSION_ROLE: '',
      KYBERION_DELEGATED_ROLE: '',
      KYBERION_PERSONA: 'worker',
      KYBERION_SUDO: '',
    });
    expect(serverDelegatedChildEnv('mission_controller', { KYBERION_SUDO: 'true' })).toMatchObject({
      SYSTEM_ROLE: 'concierge',
      MISSION_ROLE: 'mission_controller',
      KYBERION_DELEGATED_ROLE: 'mission_controller@concierge',
      KYBERION_SUDO: '',
    });
    expect(governedWorkerEnv('dot_lifecycle_worker')).toMatchObject({
      SYSTEM_ROLE: 'dot_lifecycle_worker',
      KYBERION_SUDO: '',
    });
  });
});
