/**
 * R14 — hermetic process smoke for the 26 classified CLI probes
 * (tests/fixtures/cli-reliability/probes.json).
 *
 * Every case spawns the real CLI process against a dedicated fixture root —
 * never the operator HOME, real tenant ledgers, real credentials, network or
 * native providers. Expectations come from probes.json (`expected_outcome`,
 * `allowed_exits`, `smoke_contract`), not from learned output: an
 * expected-denial or expected-attention that matches its contract is a pass,
 * and env-blocked real-hardware cases report blocked (skipped with a stated
 * reason), never pass.
 *
 * Ordering: help/unknown/outside-read (no fixture needed) → pure readiness →
 * fixture-backed happy paths. Supplementary cases S01–S04 cover the argv/JSON
 * contract surfaces the 26 probes do not reach (help, --json stderr envelope,
 * the pnpm-wrapped variant class).
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  CHECKOUT_ROOT,
  SMOKE_ROOT,
  hostBinaryAvailable,
  runCliCase,
  seedCaseRoot,
  syntheticWavBuffer,
  type SmokeFixtureSpec,
} from './support/cli-reliability-harness.js';

interface SmokeContract {
  launcher: 'direct' | 'pnpm-script' | 'script-entry';
  timeout_ms?: number;
  fixture?: {
    persisted_scope?: boolean;
    mirror_dist?: boolean;
    files?: Record<string, string>;
    env?: Record<string, string>;
  };
  assert?: {
    stdout_includes?: string[];
    stdout_excludes?: string[];
    stderr_includes?: string[];
    stderr_excludes?: string[];
    combined_includes?: string[];
    combined_excludes?: string[];
  };
  side_effects?: 'none' | 'runtime-state';
  env_blocked?: 'native-ocr' | 'ffmpeg-missing';
}

interface ProbeEntry {
  id: string;
  argv: string[];
  expected_outcome: string;
  allowed_exits: number[];
  classification: string;
  expectation_revision?: string;
  smoke_contract?: SmokeContract;
}

const probes = JSON.parse(
  fs.readFileSync(
    path.join(CHECKOUT_ROOT, 'tests', 'fixtures', 'cli-reliability', 'probes.json'),
    'utf8'
  )
) as { probes: ProbeEntry[] };

/** A public-scope charter + a not-visible ledger row -> `dot status` reports partial, not a crash. */
const FIXTURE_CHARTER = JSON.stringify(
  {
    kind: 'dot-charter',
    dot_id: 'fixture-guardian',
    version: '1.0.0',
    title: 'Fixture guardian',
    purpose: 'Synthetic charter for the cli-reliability smoke.',
    status: 'active',
    scope: { tier: 'public' },
    goal: {
      statement: 'smoke fixture',
      budget: { max_turns_per_wake: 1, wall_clock_ms_per_wake: 60000 },
    },
    attention: { triggers: [{ kind: 'cron', cron: '0 0 * * *', timezone: 'Asia/Tokyo' }] },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'surface', channel: 'fixture-channel' } },
    runtime: { heartbeat_id: 'dot-fixture-guardian' },
  },
  null,
  2
);

/** Well-formed shared index row whose private scope this process may not hydrate. */
const NOT_VISIBLE_LEDGER_ROW = JSON.stringify({
  action_ref: 'fixture-action-1',
  dot_id: 'fixture-guardian',
  actor_id: 'fixture-actor',
  action_id: 'fixture-action-id',
  title: 'fixture action',
  objective: 'fixture objective',
  work_shape: 'analysis',
  status: 'admitted',
  proposal_hash: 'fixture-hash',
  at: '2026-10-31T00:00:00.000Z',
  scope: { tier: 'personal', owner_nhi: 'fixture-other-owner' },
  private_content_hash: '0'.repeat(64),
});

function materializeFixtureFiles(contract?: SmokeContract): Record<string, string | Buffer> {
  const files: Record<string, string | Buffer> = {};
  for (const [relative, marker] of Object.entries(contract?.fixture?.files ?? {})) {
    if (marker === '<binary:fake-wav>') files[relative] = Buffer.from('fake-wav', 'ascii');
    else if (marker === '<binary:valid-wav>') files[relative] = syntheticWavBuffer();
    else if (marker === '<charter>') files[relative] = FIXTURE_CHARTER;
    else if (marker === '<ledger:not_visible>') files[relative] = `${NOT_VISIBLE_LEDGER_ROW}\n`;
    else files[relative] = marker;
  }
  return files;
}

/** env_blocked reasons — evaluated once at collection; a satisfied condition reports blocked. */
function blockedReason(condition: SmokeContract['env_blocked']): string | null {
  switch (condition) {
    case 'native-ocr':
      return (
        'native OCR/vision backend (Apple Vision et al.) is a real native provider — ' +
        'the hermetic lane never installs or calls it; covered by the R15 macOS/native lane'
      );
    case 'ffmpeg-missing':
      return hostBinaryAvailable('ffmpeg')
        ? null
        : 'ffmpeg/ffprobe not on PATH — the media pipeline cannot run on this host';
    default:
      return null;
  }
}

const RUNTIME_STATE_PREFIXES = ['active/', 'home/', 'tmp/'];

function assertSideEffects(
  allowance: 'none' | 'runtime-state',
  sideEffects: { created: string[]; changed: string[]; deleted: string[] }
): void {
  const all = [...sideEffects.created, ...sideEffects.changed, ...sideEffects.deleted];
  if (allowance === 'none') {
    expect(all, `expected zero side effects, got: ${all.join(', ')}`).toHaveLength(0);
    return;
  }
  const outside = all.filter(
    (file) => !RUNTIME_STATE_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
  expect(
    outside,
    `side effects escaped the runtime-state floors: ${outside.join(', ')}`
  ).toHaveLength(0);
}

function assertMarkers(contract: SmokeContract | undefined, stdout: string, stderr: string) {
  const assertions = contract?.assert ?? {};
  const combined = `${stdout}\n${stderr}`;
  for (const marker of assertions.stdout_includes ?? [])
    expect(stdout, `stdout missing marker ${marker}`).toContain(marker);
  for (const marker of assertions.stdout_excludes ?? [])
    expect(stdout, `stdout leaked marker ${marker}`).not.toContain(marker);
  for (const marker of assertions.stderr_includes ?? [])
    expect(stderr, `stderr missing marker ${marker}`).toContain(marker);
  for (const marker of assertions.stderr_excludes ?? [])
    expect(stderr, `stderr leaked marker ${marker}`).not.toContain(marker);
  for (const marker of assertions.combined_includes ?? [])
    expect(combined, `output missing marker ${marker}`).toContain(marker);
  for (const marker of assertions.combined_excludes ?? [])
    expect(combined, `output leaked marker ${marker}`).not.toContain(marker);
}

function specFor(probe: ProbeEntry): SmokeFixtureSpec {
  const contract = probe.smoke_contract;
  return {
    persistedScope: contract?.fixture?.persisted_scope,
    mirrorDist: contract?.fixture?.mirror_dist,
    env: contract?.fixture?.env,
    files: materializeFixtureFiles(contract),
  };
}

async function runProbe(probe: ProbeEntry) {
  const contract = probe.smoke_contract;
  const root = seedCaseRoot(probe.id, specFor(probe));
  const result = await runCliCase(root, contract?.launcher ?? 'direct', probe.argv, {
    timeoutMs: contract?.timeout_ms ?? 120_000,
    env: contract?.fixture?.env,
  });
  return { root, result };
}

// Clean the whole smoke tree — fixtures are regenerable scratch, never kept state.
afterAll(() => {
  fs.rmSync(SMOKE_ROOT, { recursive: true, force: true });
});

describe('cli-reliability smoke — fixture-free negatives and help', () => {
  const ids = ['P20-unknown-command', 'P21-read-outside-missing'];
  for (const id of ids) {
    const probe = probes.probes.find((entry) => entry.id === id)!;
    it(
      `${probe.id} (${probe.classification})`,
      { timeout: (probe.smoke_contract?.timeout_ms ?? 120_000) + 120_000 },
      async () => {
        const { result } = await runProbe(probe);
        expect(result.timedOut, 'process timed out').toBe(false);
        expect(result.exit, `exit code (stderr: ${result.stderr.slice(-400)})`).toBeTypeOf(
          'number'
        );
        expect(probe.allowed_exits, `exit ${result.exit} not in allowed set`).toContain(
          result.exit!
        );
        assertMarkers(probe.smoke_contract, result.stdout, result.stderr);
        assertSideEffects(
          probe.smoke_contract?.side_effects ?? 'runtime-state',
          result.sideEffects
        );
      }
    );
  }

  it(
    'S01 --help exits 0 without credential/provider/bootstrap work',
    { timeout: 120_000 },
    async () => {
      const root = seedCaseRoot('S01-help');
      const result = await runCliCase(root, 'direct', ['kyberion', '--help'], {
        timeoutMs: 60_000,
      });
      expect(result.timedOut).toBe(false);
      expect(result.exit).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      assertSideEffects('none', result.sideEffects);
    }
  );

  it(
    'S02 kyberion dispatcher keeps the human error format under --json (stdout empty)',
    { timeout: 120_000 },
    async () => {
      const root = seedCaseRoot('S02-read-outside-json');
      const result = await runCliCase(
        root,
        'direct',
        ['kyberion', 'read', '/nonexistent/file.pdf', '--json'],
        { timeoutMs: 60_000 }
      );
      expect(result.timedOut).toBe(false);
      expect(result.exit).toBe(1);
      expect(result.stdout.trim()).toBe('');
      expect(result.stderr).toContain('outside the repository');
      expect(result.stderr).toContain('next:');
      // The dispatcher's defineScript runs with flags: [] — errors are
      // `what — why | next` text; the JSON envelope belongs to script entries.
      expect(() => JSON.parse(result.stderr.trim())).toThrow();
    }
  );

  it(
    'S03 script entry --json failure emits a single stderr JSON envelope',
    { timeout: 120_000 },
    async () => {
      const root = seedCaseRoot('S03-rank-json-envelope');
      const result = await runCliCase(
        root,
        'script-entry',
        ['dist/scripts/context_ranker.js', '--bogus', '--json'],
        { timeoutMs: 60_000 }
      );
      expect(result.timedOut).toBe(false);
      expect(result.exit).toBe(1);
      expect(result.stdout.trim()).toBe('');
      const envelope = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe('INVALID_USAGE');
      expect(envelope.category).toBe('invalid_input');
    }
  );

  it(
    'S04 pnpm-wrapped variant still refuses an unknown command',
    { timeout: 120_000 },
    async () => {
      const root = seedCaseRoot('S04-pnpm-unknown', { mirrorDist: true });
      const result = await runCliCase(
        root,
        'pnpm-script',
        ['kyberion', 'definitely-not-a-command'],
        {
          timeoutMs: 90_000,
        }
      );
      expect(result.timedOut).toBe(false);
      expect(result.exit).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('definitely-not-a-command');
    }
  );
});

describe('cli-reliability smoke — probes', () => {
  const skip = new Set(['P20-unknown-command', 'P21-read-outside-missing']);
  for (const probe of probes.probes) {
    if (skip.has(probe.id)) continue;
    const blocked = blockedReason(probe.smoke_contract?.env_blocked);
    const label = `${probe.id} (${probe.classification}${blocked ? ', env-blocked' : ''})`;
    it.skipIf(Boolean(blocked))(
      label,
      { timeout: (probe.smoke_contract?.timeout_ms ?? 120_000) + 120_000 },
      async () => {
        const { result } = await runProbe(probe);
        expect(result.timedOut, `${probe.id} timed out`).toBe(false);
        expect(
          probe.allowed_exits,
          `exit ${result.exit} not in allowed set (stderr tail: ${result.stderr.slice(-300)})`
        ).toContain(result.exit!);
        assertMarkers(probe.smoke_contract, result.stdout, result.stderr);
        assertSideEffects(
          probe.smoke_contract?.side_effects ?? 'runtime-state',
          result.sideEffects
        );
      }
    );
    if (blocked) {
      it(`${probe.id} reports env-blocked (never passes as a substitute)`, () => {
        expect(blocked).toBeTruthy();
      });
    }
  }
});
