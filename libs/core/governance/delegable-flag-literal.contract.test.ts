import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeLstat, safeReaddir, safeReadFile } from '../secure-io.js';

/**
 * Registration ceremony for the `delegable` flag on external-operation facts:
 * a call site must derive the flag from the delegation registry via
 * `isDelegableExternalOperation(...)`, never from a bare `true`/`false`
 * literal that silently drifts from `EXTERNAL_OPERATION_DELEGATION`. A flag
 * that is deliberately forced off by context (not by the registry) belongs in
 * DELEGABLE_LITERAL_ALLOWLIST with a one-line reason; an empty reason or a
 * new literal fails this test.
 */
const SCAN_DIRS = ['libs', 'scripts'];
const SKIP_DIR = new Set(['dist', 'node_modules', '.next', 'generated']);

/** Bare `delegable: true|false` literals — computed expressions are fine. */
const LITERAL_RE = /delegable:\s*(?:true|false)\b/;

/**
 * Sites whose flag is context-forced rather than registry-derived, with the
 * reason. An entry here is debt: converge it when a registry-level projection
 * can express the context.
 */
const DELEGABLE_LITERAL_ALLOWLIST: Record<string, string> = {
  'libs/core/integrations/email-bridge.ts':
    'custom adapter backends hide accounts/defaults this boundary cannot classify; human review is mandatory by design',
  'libs/actuators/service-actuator/src/service-actuator-helpers.ts':
    'generic service effects carry no registered operation id at flag construction; the PRESET path derives the flag from reviewed preset risk',
};

function* walk(dir: string): Generator<string> {
  if (!safeExistsSync(dir)) return;
  for (const entry of safeReaddir(dir)) {
    if (SKIP_DIR.has(entry) || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const stat = safeLstat(full);
    if (stat?.isDirectory()) yield* walk(full);
    else if (/\.ts$/.test(entry) && !entry.endsWith('.d.ts') && !entry.includes('.test.'))
      yield full;
  }
}

describe('delegable flag literal scan', () => {
  const root = pathResolver.rootResolve('.');

  it('no external-operation call site hardcodes delegable: true|false', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(root, dir))) {
        const rel = path.relative(root, file);
        if (rel in DELEGABLE_LITERAL_ALLOWLIST) continue;
        const text = String(safeReadFile(file, { encoding: 'utf8' }));
        if (LITERAL_RE.test(text)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlisted literal has a reason and still exists', () => {
    for (const [file, reason] of Object.entries(DELEGABLE_LITERAL_ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(20);
      const text = String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' }));
      expect(LITERAL_RE.test(text), `${file} no longer needs its allowlist entry`).toBe(true);
    }
  });
});
