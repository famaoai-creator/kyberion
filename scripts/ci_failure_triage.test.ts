import { describe, expect, it } from 'vitest';
import {
  normalizeCiLine,
  renderTriageMarkdown,
  splitCiLog,
  triageCiLog,
  RESOLVE_GENERATED_GATE_IDS,
} from './lib/ci-failure-triage.js';
import { deriveGateRemedies, loadGateRemedies, main } from './ci_failure_triage.js';
import { GENERATED_ARTIFACT_STEPS } from './resolve_generated.js';

/**
 * Fixtures are excerpts of real CI logs from this repository (GitHub step-log
 * timestamps and ANSI colour codes kept): the macOS core shard that went red on
 * main on 2026-10-19 (peer-task-exchange TTL flake, fixed in #1186), the
 * op-registry drift from #1182/#1184 and a type-ratchet growth.
 */
const MACOS_FLAKE_LOG = [
  '2026-10-19T05:45:51.2542670Z \u001b[31m⎯⎯⎯\u001b[39m\u001b[1m\u001b[41m Failed Tests 1 \u001b[49m\u001b[22m\u001b[31m⎯⎯⎯\u001b[39m',
  '2026-10-19T05:45:51.2542940Z ',
  '2026-10-19T05:45:51.2543750Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m libs/core/mesh/peer-task-exchange.test.ts\u001b[2m > \u001b[22mpeer task exchange\u001b[2m > \u001b[22mexpires an unaccepted task for both sides and tells the proposer',
  "2026-10-19T05:45:51.2544750Z \u001b[31m\u001b[1mAssertionError\u001b[22m: expected 'rejected' to be 'expired' // Object.is equality\u001b[39m",
  '2026-10-19T05:45:51.2545050Z ',
  '2026-10-19T05:45:51.2545230Z Expected: \u001b[32m"\u001b[7mexpir\u001b[27med"\u001b[39m',
  '2026-10-19T05:45:51.2545540Z Received: \u001b[31m"\u001b[7mreject\u001b[27med"\u001b[39m',
  '2026-10-19T05:45:51.2546020Z \u001b[36m \u001b[2m❯\u001b[22m libs/core/mesh/peer-task-exchange.test.ts:\u001b[2m422:88\u001b[22m\u001b[39m',
  '2026-10-19T05:45:51.2645040Z [ELIFECYCLE] Test failed. See above for more details.',
  '2026-10-19T05:45:51.2757460Z ##[error]Process completed with exit code 1.',
].join('\n');

const OP_REGISTRY_DRIFT_LOG = [
  '[check] scope=full gates=81 failed=1',
  '- PASSED pinned-deps',
  '- FAILED op-registry',
  '  stdout: {',
  '  "ok": false,',
  '  "changed": [',
  '    "knowledge/product/governance/actuator-op-discovery.json"',
  '  ]',
  '}',
  '- PASSED vocabulary-types',
  '[ELIFECYCLE] Command failed with exit code 1.',
].join('\n');

const TYPE_RATCHET_LOG = [
  '[check] scope=pr gates=48 failed=1',
  '- FAILED type-ratchet',
  '  stderr: [check:type-ratchet] violations detected:',
  '- test.any_keywords increased from 1587 to 1588',
  '- PASSED module-boundaries',
].join('\n');

const BOUNDARY_TEST_LOG = [
  ' FAIL  tests/shared-tmp-ratchet.test.ts > shared tmp ratchet > keeps every sharedTmp call site registered',
  "AssertionError: expected [ 'scripts/new_thing.ts' ] to deeply equal []",
].join('\n');

const INFRA_LOG = [
  '2026-10-19T04:00:01.0000000Z Progress: resolved 1, reused 0, downloaded 0, added 0',
  '2026-10-19T04:00:31.0000000Z  ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/vitest: request to https://registry.npmjs.org/vitest failed, reason: read ECONNRESET',
  '2026-10-19T04:00:31.1000000Z ##[error]Process completed with exit code 1.',
].join('\n');

const REMEDIES = deriveGateRemedies(
  {
    gates: [
      {
        id: 'op-registry',
        executable: 'node',
        args: ['--import', './scripts/ts-loader.mjs', 'scripts/generate_op_registry.ts', '--check'],
      },
      {
        id: 'capability-seams',
        executable: 'node',
        args: [
          '--import',
          './scripts/ts-loader.mjs',
          'scripts/generate_capability_seams.ts',
          '--check',
        ],
      },
      { id: 'type-ratchet', executable: 'node', args: ['dist/scripts/check_type_ratchet.js'] },
    ],
  },
  {
    'generate:op-registry': 'node --import ./scripts/ts-loader.mjs scripts/generate_op_registry.ts',
  }
);

describe('ci failure triage', () => {
  it('strips ANSI codes and GitHub timestamp prefixes', () => {
    expect(normalizeCiLine('2026-10-19T05:45:51.2645040Z \u001b[31mboom\u001b[39m')).toBe('boom');
  });

  it('derives generator commands from the gate manifest and package scripts', () => {
    expect(REMEDIES['op-registry']).toEqual({
      check: 'pnpm check -- --only op-registry',
      generator: 'pnpm generate:op-registry',
    });
    expect(REMEDIES['capability-seams']?.generator).toBe(
      'node --import ./scripts/ts-loader.mjs scripts/generate_capability_seams.ts'
    );
    expect(REMEDIES['type-ratchet']?.generator).toBeUndefined();
  });

  it('classifies a freshness-gate failure as generated-drift with the generator command', () => {
    const report = triageCiLog(OP_REGISTRY_DRIFT_LOG, { gateRemedies: REMEDIES });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({
      class: 'generated-drift',
      gate: 'op-registry',
      changed: ['knowledge/product/governance/actuator-op-discovery.json'],
      next: ['pnpm generate:op-registry', 'pnpm check -- --only op-registry'],
    });
  });

  it('falls back to resolve generated for a drift gate without a known generator', () => {
    const report = triageCiLog(
      '- FAILED env-registry\n  stdout: {"ok":false,"changed":["docs/developer/env.example"]}'
    );
    expect(report.failures[0]?.class).toBe('generated-drift');
    expect(report.failures[0]?.next).toContain('pnpm kyberion resolve generated');
  });

  it('classifies ratchet growth and boundary tests as ratchet/registration', () => {
    const ratchet = triageCiLog(TYPE_RATCHET_LOG, { gateRemedies: REMEDIES }).failures;
    expect(ratchet).toHaveLength(1);
    expect(ratchet[0]).toMatchObject({
      class: 'ratchet/registration',
      gate: 'type-ratchet',
      evidence: ['- test.any_keywords increased from 1587 to 1588'],
      doc: 'knowledge/product/governance/kyberion-development-practices.md',
    });
    const boundary = triageCiLog(BOUNDARY_TEST_LOG).failures;
    expect(boundary[0]).toMatchObject({
      class: 'ratchet/registration',
      file: 'tests/shared-tmp-ratchet.test.ts',
    });
  });

  it('marks a timing-shaped Linux test failure as a suspected flake with a rerun command', () => {
    const report = triageCiLog(MACOS_FLAKE_LOG, { job: 'core-tests (shard 3/6)' });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({
      class: 'test-failure',
      suspectedFlake: true,
      file: 'libs/core/mesh/peer-task-exchange.test.ts',
      test: 'peer task exchange > expires an unaccepted task for both sides and tells the proposer',
    });
    expect(report.failures[0]?.evidence[0]).toBe(
      "AssertionError: expected 'rejected' to be 'expired' // Object.is equality"
    );
    expect(report.failures[0]?.next[0]).toBe(
      "pnpm exec vitest run libs/core/mesh/peer-task-exchange.test.ts -t 'expires an unaccepted task for both sides and tells the proposer'"
    );
  });

  it('classifies a failure seen only in macOS/Windows jobs as platform', () => {
    const report = triageCiLog(MACOS_FLAKE_LOG, { job: 'macos-latest / Node 24 / shard 3/3' });
    expect(report.failures[0]).toMatchObject({ class: 'platform', suspectedFlake: true });
  });

  it('splits gh --log-failed output by job and keeps a Linux+macOS failure as test-failure', () => {
    const prefixed = (job: string) =>
      MACOS_FLAKE_LOG.split('\n')
        .map((line) => `${job}\tUnit tests\t${line}`)
        .join('\n');
    const text = `${prefixed('macos-latest / Node 24 / shard 3/3')}\n${prefixed('ubuntu-latest / Node 24 / shard 3/3')}`;
    expect(splitCiLog(text).map((segment) => segment.job)).toEqual([
      'macos-latest / Node 24 / shard 3/3',
      'ubuntu-latest / Node 24 / shard 3/3',
    ]);
    const report = triageCiLog(text);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.class).toBe('test-failure');
    expect(report.failures[0]?.job).toContain('ubuntu-latest');
  });

  it('classifies install/network errors before tests as infra', () => {
    const report = triageCiLog(INFRA_LOG);
    expect(report.failures).toEqual([
      expect.objectContaining({ class: 'infra', title: 'infrastructure: pnpm install failed' }),
    ]);
  });

  it('falls back to unknown with the first error block', () => {
    const report = triageCiLog('setup ok\nError: something odd happened\n  at x (y.js:1:1)\n');
    expect(report.failures[0]).toMatchObject({ class: 'unknown' });
    expect(report.failures[0]?.evidence[0]).toBe('Error: something odd happened');
  });

  it('does not mistake passing gates or warn-level chatter for an error block', () => {
    const report = triageCiLog(
      [
        '[check] scope=pr gates=48 failed=0',
        '- PASSED wire-error-boundary',
        '[2026-10-19T05:42:51.223Z] [WARN] [fs-utils] suppressed error in walk: Error: denied',
      ].join('\n')
    );
    expect(report).toEqual({ ok: true, jobs: [], failures: [] });
  });

  it('keeps signatures stable across runs (numbers do not change identity)', () => {
    const first = triageCiLog(TYPE_RATCHET_LOG).failures[0]?.signature;
    const second = triageCiLog(TYPE_RATCHET_LOG.replace('1588', '1590')).failures[0]?.signature;
    expect(first).toMatch(/^[0-9a-f]{12}$/u);
    expect(second).toBe(first);
  });

  it('renders a Markdown summary with a table and per-failure next commands', () => {
    const markdown = renderTriageMarkdown(
      triageCiLog(`${OP_REGISTRY_DRIFT_LOG}\n${MACOS_FLAKE_LOG}`, { gateRemedies: REMEDIES })
    );
    expect(markdown).toContain('## CI failure triage');
    expect(markdown).toContain('| 1 | `generated-drift` |');
    expect(markdown).toContain('pnpm generate:op-registry');
    expect(markdown).toContain('(suspected flake)');
  });

  it('escapes backslashes before pipes so a log title cannot break the summary table', () => {
    const markdown = renderTriageMarkdown({
      ok: false,
      jobs: [],
      failures: [
        {
          class: 'unknown',
          signature: 'abcdefabcdef',
          title: String.raw`regex a\|b | c`,
          evidence: [],
          next: [String.raw`grep 'x\|y'`],
        },
      ],
    });
    const row = markdown.split('\n').find((line) => line.startsWith('| 1 |'))!;
    // Every literal pipe from the input is escaped, so only the 5 column borders stay bare.
    expect(row.match(/(?<!\\)\|/gu)).toHaveLength(5);
    expect(row).toContain(String.raw`regex a\\\|b \| c`);
  });

  it('keeps the resolve-generated gate list in step with scripts/resolve_generated.ts', () => {
    expect([...RESOLVE_GENERATED_GATE_IDS].sort()).toEqual(
      GENERATED_ARTIFACT_STEPS.map((step) => step.id).sort()
    );
  });

  it('derives remedies for the real gate manifest', () => {
    const remedies = loadGateRemedies();
    expect(remedies['op-registry']?.generator).toBe('pnpm generate:op-registry');
    expect(remedies['env-registry']?.generator).toBe('pnpm generate:env-registry');
    expect(remedies['type-ratchet']?.generator).toBeUndefined();
  });

  it('exits 1 when a named log file does not exist', async () => {
    const previous = process.exitCode;
    try {
      await main(['--quiet', 'active/shared/tmp/ci-triage-missing-fixture.log']);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
    }
  });
});
