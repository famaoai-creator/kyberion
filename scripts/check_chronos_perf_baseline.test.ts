import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The weekly ce-chronos-perf schedule runs `check chronos-perf` as a pipeline
 * `system:shell` step, so the child inherits the runner's role (observed:
 * run_pipeline.bundle) instead of deriving one from this script's file name.
 * The script therefore assumes CHRONOS_PERF_ROLE for its single write. Runs
 * the real authority / tier-guard stack against a hermetic KYBERION_ROOT with
 * a copy of the checked-in governance policies — under the repo root Vitest
 * does not load the policy, so every write would look allowed.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENV_KEYS = ['KYBERION_ROOT', 'SYSTEM_ROLE', 'MISSION_ROLE', 'KYBERION_PERSONA'] as const;

let root = '';
const original: Record<string, string | undefined> = {};
let authority: typeof import('@agent/core/authority');
let tierGuard: typeof import('@agent/core/tier-guard');
let perf: typeof import('./check_chronos_perf_baseline.js');

describe('check_chronos_perf_baseline role', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-chronos-perf-role-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"hermetic"}\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# hermetic\n');
    // Copied, not linked: the policy engine refuses a symlinked policy path.
    for (const dir of ['governance', 'schemas']) {
      fs.cpSync(
        path.join(REPO_ROOT, 'knowledge', 'product', dir),
        path.join(root, 'knowledge', 'product', dir),
        { recursive: true }
      );
    }
    for (const key of ENV_KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
    process.env.KYBERION_ROOT = root;
    // The role a pipeline `system:shell` child inherits from the runner.
    process.env.MISSION_ROLE = 'run_pipeline.bundle';
    authority = await import('@agent/core/authority');
    tierGuard = await import('@agent/core/tier-guard');
    perf = await import('./check_chronos_perf_baseline.js');
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const target = (relative: string) => path.join(root, relative);
  const report = () => target(`active/shared/${perf.CHRONOS_PERF_REPORT}`);

  it('denies the report write under the role inherited from the pipeline runner', () => {
    expect(tierGuard.validateWritePermission(report()).allowed).toBe(false);
  });

  it('allows exactly the report file under the assumed role', () => {
    const verdicts = authority.withExecutionContext(perf.CHRONOS_PERF_ROLE, () => ({
      report: tierGuard.validateWritePermission(report()).allowed,
      sibling: tierGuard.validateWritePermission(
        target('active/shared/observability/chronos/state.json')
      ).allowed,
      coordination: tierGuard.validateWritePermission(
        target('active/shared/coordination/chronos/state.json')
      ).allowed,
      product: tierGuard.validateWritePermission(
        target('knowledge/product/governance/security-policy.json')
      ).allowed,
    }));
    expect(verdicts).toEqual({ report: true, sibling: false, coordination: false, product: false });
  });
});
