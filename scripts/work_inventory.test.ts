import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { writeMemberProfile } from '@agent/core/member-registry';
import {
  applyClassification,
  createWorkInventoryEntry,
  listWorkInventoryEntries,
  loadWorkInventoryEntry,
  saveWorkInventoryEntry,
  WorkInventoryStoreError,
  type WorkInventoryEntry,
  type WorkInventoryStep,
} from '@agent/core/work-inventory';
import type { WorkInventoryScoreResult } from '@agent/core/work-inventory-scoring';
import type { WorkInventoryConsent } from '@agent/core/work-inventory-consent';

import { run } from './work_inventory.js';
import type {
  AddResult,
  ShowResult,
  WorkInventoryCliOptions,
} from './lib/work-inventory-cli-entries.js';
import {
  runAdd,
  runCandidates,
  runClassify,
  runList,
  runMigrate,
  runOverride,
  runShow,
  runStatus,
} from './lib/work-inventory-cli-entries.js';
import { runHarvest } from './lib/work-inventory-cli-harvest.js';
import {
  runConsentGrant,
  runConsentList,
  runConsentRevoke,
  runObserveConfirm,
  runObserveList,
  runObserveSummarize,
  resolveRecordingPath,
} from './lib/work-inventory-cli-consent.js';
import { runLearn, runPromote, type PromoteResult } from './lib/work-inventory-cli-promotion.js';
import {
  parseDaysFlag,
  parseEffortMinutesFlag,
  parseFrequencyFlag,
  parseLimitFlag,
  requireDecidedBy,
  resolveScope,
  WorkInventoryCliUsageError,
} from './lib/work-inventory-cli-shared.js';

const NOW = new Date('2026-09-22T09:00:00.000Z');

const tmpRoot = pathResolver.rootResolve('active/shared/tmp/work-inventory-cli-test');
const opts: WorkInventoryCliOptions & { now: Date } = { rootDir: tmpRoot, now: NOW };

afterEach(() => {
  safeRmSync(tmpRoot, { recursive: true, force: true });
});

/** Provisions the local owner member inside the isolated root (what onboarding does for real). */
function provisionOwner(): void {
  writeMemberProfile(
    {
      member_id: 'owner',
      display_name: 'Owner',
      status: 'active',
      memberships: [],
      access_registrations: [],
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
    { rootDir: tmpRoot }
  );
}

// ---------------------------------------------------------------------------
// Shared argv helpers
// ---------------------------------------------------------------------------

describe('work-inventory-cli-shared argument parsing', () => {
  it('resolves tenant vs personal scope', () => {
    expect(resolveScope(['list'])).toEqual({});
    expect(resolveScope(['list', '--tenant', 'acme-corp'])).toEqual({ tenant_slug: 'acme-corp' });
  });

  it('parses --frequency and rejects a malformed value', () => {
    expect(parseFrequencyFlag(['add', '--frequency', 'week:3'])).toEqual({ per: 'week', count: 3 });
    expect(parseFrequencyFlag(['add'])).toBeUndefined();
    expect(() => parseFrequencyFlag(['add', '--frequency', 'fortnight:1'])).toThrow(
      WorkInventoryCliUsageError
    );
  });

  it('parses --effort-minutes, --days, and --limit with validation', () => {
    expect(parseEffortMinutesFlag(['add', '--effort-minutes', '30'])).toBe(30);
    expect(() => parseEffortMinutesFlag(['add', '--effort-minutes', '-1'])).toThrow();
    expect(parseDaysFlag(['harvest', '--days', '7'])).toBe(7);
    expect(parseDaysFlag(['harvest'])).toBe(28);
    expect(() => parseDaysFlag(['harvest', '--days', '0'])).toThrow();
    expect(parseLimitFlag(['candidates', '--limit', '5'])).toBe(5);
    expect(() => parseLimitFlag(['candidates', '--limit', '0'])).toThrow();
  });

  it('requires a well-formed --decided-by and maps it to a bare member id', () => {
    expect(() => requireDecidedBy(['status'])).toThrow(WorkInventoryCliUsageError);
    expect(() => requireDecidedBy(['status', '--decided-by', 'agent:bot'])).toThrow();
    const decided = requireDecidedBy(['status', '--decided-by', 'user:alice']);
    expect(decided).toEqual({ kind: 'human', id: 'user:alice' });
  });
});

// ---------------------------------------------------------------------------
// add / list / show / classify / override / status / candidates
// ---------------------------------------------------------------------------

describe('inventory entry lifecycle (hermetic)', () => {
  it('add requires --title', async () => {
    await expect(runAdd(['add'], opts)).rejects.toThrow(WorkInventoryCliUsageError);
  });

  it('add without --steps saves an empty draft entry', async () => {
    const result = await runAdd(['add', '--title', 'Empty draft'], opts);
    expect(result.source).toBe('empty');
    expect(result.entry.steps).toEqual([]);
    expect(result.entry.status).toBe('draft');
  });

  it('add --no-model decomposes steps heuristically and classifies them', async () => {
    const result = await runAdd(
      [
        'add',
        '--title',
        '月次売上報告',
        '--steps',
        'メールを開く → 添付Excelを保存 → 基幹システムにログイン → 売上CSVをダウンロード',
        '--systems',
        '基幹システム,Slack',
        '--api-systems',
        'Slack',
        '--frequency',
        'month:1',
        '--effort-minutes',
        '180',
        '--no-model',
      ],
      opts
    );
    expect(result.source).toBe('heuristic');
    expect(result.entry.steps.length).toBeGreaterThan(0);
    expect(result.entry.frequency).toEqual({ per: 'month', count: 1 });
    expect(result.entry.effort_minutes_per_run).toBe(180);
    for (const step of result.entry.steps) {
      expect(step.method.assigned).toBeTruthy();
    }

    const listed = runList(['list'], opts);
    expect(listed.map((e) => e.entry_id)).toContain(result.entry.entry_id);

    const filtered = runList(['list', '--status', 'draft'], opts);
    expect(filtered.every((e) => e.status === 'draft')).toBe(true);
  });

  it('show returns not-found for an unknown entry', () => {
    expect(() => runShow('WI-20260922-does-not-exist', ['show'], opts)).toThrow(
      WorkInventoryCliUsageError
    );
  });

  it('classify re-derives step methods from --api-systems', async () => {
    const added = await runAdd(
      [
        'add',
        '--title',
        'Classify me',
        '--steps',
        'Slackで確認する',
        '--systems',
        'Slack',
        '--no-model',
      ],
      opts
    );
    const beforeMethod = added.entry.steps[0]?.method.assigned;
    const classified = runClassify(
      added.entry.entry_id,
      ['classify', '--api-systems', 'Slack'],
      opts
    );
    expect(classified.steps[0]?.method.rule_id).toBeTruthy();
    // Re-classifying with the system now known to have an API can change the assignment.
    expect(typeof beforeMethod).toBe('string');
  });

  it('override requires --decided-by and records a human_override', async () => {
    const added = await runAdd(
      ['add', '--title', 'Override me', '--steps', 'Slackで確認する', '--no-model'],
      opts
    );
    const stepId = added.entry.steps[0].step_id;
    expect(() =>
      runOverride(
        added.entry.entry_id,
        ['override', '--step', stepId, '--method', 'human', '--reason', 'needs a human'],
        opts
      )
    ).toThrow(WorkInventoryCliUsageError);

    const overridden = runOverride(
      added.entry.entry_id,
      [
        'override',
        '--step',
        stepId,
        '--method',
        'human',
        '--reason',
        'needs a human',
        '--decided-by',
        'user:alice',
      ],
      opts
    );
    const step = overridden.steps.find((s) => s.step_id === stepId) as WorkInventoryStep;
    expect(step.method.source).toBe('human_override');
    expect(step.method.rationale).toContain('needs a human');
    expect(step.method.rationale).toContain('user:alice');
  });

  it('add never overwrites an existing entry with the same id', async () => {
    const first = await runAdd(['add', '--title', '経費精算 Excel'], opts);
    const second = await runAdd(['add', '--title', '売上集計 Excel'], opts);
    expect(second.entry.entry_id).not.toBe(first.entry.entry_id);

    // Same title, scope and instant -> same id: refused instead of overwritten.
    await expect(runAdd(['add', '--title', '経費精算 Excel'], opts)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkInventoryStoreError && error.code === 'WORK_INVENTORY_ENTRY_EXISTS'
    );
    expect(
      runList(['list'], opts)
        .map((e) => e.title)
        .sort()
    ).toEqual(['経費精算 Excel', '売上集計 Excel'].sort());
  });

  it('override refuses to downgrade a money/irreversible/approval step', () => {
    const draft = createWorkInventoryEntry(
      {
        title: 'Pay invoices',
        scope: {},
        trigger: { kind: 'schedule', description: 'monthly' },
        steps: [
          {
            step_id: 'S1',
            stage: 'act',
            verb: 'operate',
            description: 'pay the invoice',
            data_sensitivity: 'internal',
            effects: ['money'],
            method: { assigned: 'human', source: 'proposal', rationale: 'seed' },
          },
        ],
      },
      NOW
    );
    saveWorkInventoryEntry(applyClassification(draft), { rootDir: tmpRoot });
    const args = (method: string) => [
      'override',
      '--step',
      'S1',
      '--method',
      method,
      '--reason',
      'the bank has an API',
      '--decided-by',
      'user:alice',
    ];
    expect(() => runOverride(draft.entry_id, args('api'), opts)).toThrow(
      /effect money, which always stays human/
    );
    const kept = runOverride(draft.entry_id, args('human'), opts);
    expect(kept.steps[0].method).toMatchObject({ assigned: 'human', source: 'human_override' });
  });

  it('override rejects an unknown step id and an unknown method', async () => {
    const added = await runAdd(
      ['add', '--title', 'Bad override', '--steps', '確認する', '--no-model'],
      opts
    );
    expect(() =>
      runOverride(
        added.entry.entry_id,
        [
          'override',
          '--step',
          'S99',
          '--method',
          'human',
          '--reason',
          'x',
          '--decided-by',
          'user:alice',
        ],
        opts
      )
    ).toThrow(/no step/);
    expect(() =>
      runOverride(
        added.entry.entry_id,
        [
          'override',
          '--step',
          added.entry.steps[0].step_id,
          '--method',
          'robot',
          '--reason',
          'x',
          '--decided-by',
          'user:alice',
        ],
        opts
      )
    ).toThrow(/--method must be one of/);
  });

  it('status requires --decided-by, validates --to, and transitions the entry', async () => {
    const added = await runAdd(['add', '--title', 'Status me'], opts);
    expect(() => runStatus(added.entry.entry_id, ['status', '--to', 'confirmed'], opts)).toThrow(
      WorkInventoryCliUsageError
    );
    expect(() =>
      runStatus(
        added.entry.entry_id,
        ['status', '--to', 'bogus', '--decided-by', 'user:alice'],
        opts
      )
    ).toThrow(/--to must be one of/);
    const confirmed = runStatus(
      added.entry.entry_id,
      ['status', '--to', 'confirmed', '--decided-by', 'user:alice'],
      opts
    );
    expect(confirmed.status).toBe('confirmed');
  });

  it('candidates ranks entries deterministically and honors --limit', async () => {
    await runAdd(
      [
        'add',
        '--title',
        'Candidate A',
        '--steps',
        'Slackで確認する',
        '--systems',
        'Slack',
        '--api-systems',
        'Slack',
        '--frequency',
        'week:5',
        '--effort-minutes',
        '20',
        '--no-model',
      ],
      opts
    );
    await runAdd(
      [
        'add',
        '--title',
        'Candidate B',
        '--steps',
        '判断する',
        '--frequency',
        'week:1',
        '--effort-minutes',
        '5',
        '--no-model',
      ],
      opts
    );
    const all = runCandidates(['candidates'], opts);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const scores = all.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const limited = runCandidates(['candidates', '--limit', '1'], opts);
    expect(limited).toHaveLength(1);
    expect(() => parseLimitFlag(['candidates', '--limit', 'nope'])).toThrow();
  });

  it('keeps tenant-scoped and personal-scoped entries isolated', async () => {
    const personal = await runAdd(['add', '--title', 'Personal entry'], opts);
    const tenant = await runAdd(['add', '--title', 'Tenant entry', '--tenant', 'acme-corp'], opts);

    const personalList = runList(['list'], opts).map((e) => e.entry_id);
    const tenantList = runList(['list', '--tenant', 'acme-corp'], opts).map((e) => e.entry_id);

    expect(personalList).toContain(personal.entry.entry_id);
    expect(personalList).not.toContain(tenant.entry.entry_id);
    expect(tenantList).toContain(tenant.entry.entry_id);
    expect(tenantList).not.toContain(personal.entry.entry_id);

    expect(loadWorkInventoryEntry({}, tenant.entry.entry_id, { rootDir: tmpRoot })).toBeNull();
    expect(
      loadWorkInventoryEntry({ tenant_slug: 'acme-corp' }, personal.entry.entry_id, {
        rootDir: tmpRoot,
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// harvest
// ---------------------------------------------------------------------------

describe('inventory harvest (hermetic)', () => {
  it('reports zero signals against an empty fixture root and never throws', () => {
    const result = runHarvest(['harvest', '--days', '7'], { ...opts, dryRun: false });
    expect(result.signals).toEqual([]);
    expect(result.entries_updated).toEqual([]);
    expect(result.suggested).toEqual([]);
    expect(result.dry_run).toBe(false);
    expect(result.stats).toEqual({ excluded_test_or_ci: 0, untagged: 0 });
  });

  it('WI-13: excludes test/ci traces, keeps untagged legacy traces counted, and reports both stats', () => {
    const tracesDir = path.join(tmpRoot, 'active/shared/logs/traces');
    safeMkdir(tracesDir, { recursive: true });
    const trace = (id: string, hour: number, origin?: string) =>
      JSON.stringify({
        traceId: id,
        rootSpan: { name: 'pipeline:cli-origin-test', status: 'ok' },
        metadata: {
          startedAt: `2026-09-20T${String(hour).padStart(2, '0')}:00:00.000Z`,
          ...(origin ? { origin } : {}),
        },
      });
    const lines = [
      trace('untagged-1', 1),
      trace('untagged-2', 2),
      trace('test-1', 3, 'test'),
      trace('ci-1', 4, 'ci'),
    ];
    safeWriteFile(path.join(tracesDir, 'traces-2026-09-20.jsonl'), lines.join('\n'));

    const result = runHarvest(['harvest', '--days', '7'], { ...opts, dryRun: false });
    const signal = result.signals.find((s) => s.signature === 'pipeline:cli-origin-test');
    expect(signal?.count).toBe(2); // only the 2 untagged traces
    expect(result.stats).toEqual({ excluded_test_or_ci: 2, untagged: 2 });
  });

  it('--suggest skips a suggestion whose id already exists instead of overwriting it', () => {
    const tracesDir = path.join(tmpRoot, 'active/shared/logs/traces');
    safeMkdir(tracesDir, { recursive: true });
    const lines = [1, 2, 3].map((n) =>
      JSON.stringify({
        traceId: `t-${n}`,
        rootSpan: { name: 'pipeline:nightly-export', status: 'ok' },
        metadata: { startedAt: `2026-09-2${n - 1}T01:00:00.000Z` },
      })
    );
    safeWriteFile(path.join(tracesDir, 'traces-2026-09-20.jsonl'), lines.join('\n'));

    const preview = runHarvest(['harvest', '--suggest'], { ...opts, dryRun: true });
    expect(preview.suggested).toHaveLength(1);
    // Something else already holds the suggestion's id (and does not match the signal).
    const occupant: WorkInventoryEntry = {
      ...preview.suggested[0],
      title: 'Occupant',
      steps: [],
      observations: [],
    };
    saveWorkInventoryEntry(occupant, { rootDir: tmpRoot });

    const result = runHarvest(['harvest', '--suggest'], { ...opts, dryRun: false });
    expect(result.suggested).toEqual([]);
    const stored = listWorkInventoryEntries({}, { rootDir: tmpRoot });
    expect(stored.map((e) => e.title)).toEqual(['Occupant']);
  });

  it('--dry-run never saves suggested drafts', () => {
    const result = runHarvest(['harvest', '--dry-run', '--suggest'], { ...opts, dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.suggested).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// migrate (WI-17)
// ---------------------------------------------------------------------------

function legacyOcrBindingEntry(title: string): WorkInventoryEntry {
  return createWorkInventoryEntry(
    {
      title,
      scope: {},
      trigger: { kind: 'ad_hoc', description: 'test' },
      steps: [
        {
          step_id: 'S1',
          stage: 'understand',
          verb: 'read',
          description: 'ocr a screenshot',
          data_sensitivity: 'internal',
          effects: [],
          method: {
            assigned: 'ai_reasoning',
            source: 'rule',
            rule_id: 'reasoning-verbs',
            rationale: 'x',
          },
          // verb 'read''s first taxonomy candidate binding (vision-actuator /
          // ocr_image), declared here the way a pre-WI-17 entry would have
          // it — matching the default but with no `inferred` key at all.
          binding: { actuator: 'vision-actuator', op: 'ocr_image' },
        },
      ],
    },
    NOW
  );
}

describe('inventory migrate (hermetic)', () => {
  it('backfills inferred: true on a legacy default-candidate binding, saves it, and is idempotent', () => {
    const entry = legacyOcrBindingEntry('legacy binding entry');
    saveWorkInventoryEntry(entry, { rootDir: tmpRoot });

    const first = runMigrate(['migrate'], { ...opts, dryRun: false });
    expect(first.total_changed).toBe(1);
    expect(first.results).toEqual([{ entry_id: entry.entry_id, changed: 1 }]);
    expect(first.dry_run).toBe(false);

    const reloaded = loadWorkInventoryEntry({}, entry.entry_id, { rootDir: tmpRoot });
    expect(reloaded?.steps[0].binding).toEqual({
      actuator: 'vision-actuator',
      op: 'ocr_image',
      inferred: true,
    });

    const second = runMigrate(['migrate'], { ...opts, dryRun: false });
    expect(second.total_changed).toBe(0);
    expect(second.results).toEqual([]);
  });

  it('--dry-run reports the pending change but writes nothing', () => {
    const entry = legacyOcrBindingEntry('legacy binding entry (dry-run)');
    saveWorkInventoryEntry(entry, { rootDir: tmpRoot });

    const result = runMigrate(['migrate', '--dry-run'], { ...opts, dryRun: true });
    expect(result.total_changed).toBe(1);
    expect(result.dry_run).toBe(true);

    const reloaded = loadWorkInventoryEntry({}, entry.entry_id, { rootDir: tmpRoot });
    expect(reloaded?.steps[0].binding?.inferred).toBeUndefined();
  });

  it('leaves an entry with an explicit (non-default) binding out of the results entirely', () => {
    const entry = createWorkInventoryEntry(
      {
        title: 'explicit binding entry',
        scope: {},
        trigger: { kind: 'ad_hoc', description: 'test' },
        steps: [
          {
            step_id: 'S1',
            stage: 'understand',
            verb: 'read',
            description: 'read via a declared knowledge api',
            data_sensitivity: 'internal',
            effects: [],
            method: {
              assigned: 'ai_reasoning',
              source: 'rule',
              rule_id: 'reasoning-verbs',
              rationale: 'x',
            },
            binding: { actuator: 'wisdom-actuator', op: 'knowledge_read' },
          },
        ],
      },
      NOW
    );
    saveWorkInventoryEntry(entry, { rootDir: tmpRoot });

    const result = runMigrate(['migrate'], { ...opts, dryRun: false });
    expect(result.total_changed).toBe(0);
    expect(result.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// consent
// ---------------------------------------------------------------------------

describe('inventory consent (hermetic)', () => {
  const GRANT_ARGS = [
    'consent',
    'grant',
    '--sources',
    'desktop_recording,browser_recording',
    '--kinds',
    'active_window,browser_tabs',
    '--purpose',
    'find automatable steps',
    '--days',
    '30',
  ];

  it('fails with an onboarding hint when no owner member is provisioned', () => {
    expect(() => runConsentGrant(GRANT_ARGS, opts)).toThrow(/no active owner member.*onboard/);
    expect(() => runObserveList(['observe', 'list'], opts)).toThrow(/no active owner member/);
  });

  it('acts only as the local owner: another --member or --decided-by is refused', () => {
    provisionOwner();
    expect(() =>
      runConsentGrant([...GRANT_ARGS, '--member', 'alice', '--decided-by', 'user:alice'], opts)
    ).toThrow(/acts as the local owner \(owner\); --member alice is not allowed/);
    expect(() => runConsentGrant([...GRANT_ARGS, '--decided-by', 'user:bob'], opts)).toThrow(
      /--decided-by must be user:owner/
    );
    expect(() => runConsentList(['consent', 'list', '--member', 'alice'], opts)).toThrow(
      WorkInventoryCliUsageError
    );
    expect(() =>
      runObserveConfirm(
        ['observe', 'confirm', '--member', 'alice', '--summary', 'x', '--decided-by', 'user:alice'],
        opts
      )
    ).toThrow(/--member alice is not allowed/);
    expect(() =>
      runObserveSummarize(
        ['observe', 'summarize', '--member', 'alice', '--recording', 'x.json'],
        opts
      )
    ).toThrow(/--member alice is not allowed/);
  });

  it('grant -> list -> revoke round-trips as the owner', () => {
    provisionOwner();
    const granted: WorkInventoryConsent = runConsentGrant(
      [...GRANT_ARGS, '--member', 'owner', '--decided-by', 'user:owner'],
      opts
    );
    expect(granted.member_id).toBe('owner');
    expect(granted.sources).toEqual(['desktop_recording', 'browser_recording']);

    const listed = runConsentList(['consent', 'list'], opts);
    expect(listed.map((c) => c.consent_id)).toContain(granted.consent_id);

    const revoked = runConsentRevoke(['consent', 'revoke', '--consent', granted.consent_id], opts);
    expect(revoked.revoked_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// observe (argument validation only — recording fixtures are out of scope)
// ---------------------------------------------------------------------------

describe('inventory observe argument validation', () => {
  it('resolveRecordingPath rejects paths outside the recordings boundary', () => {
    expect(() => resolveRecordingPath('../../etc/passwd', tmpRoot)).toThrow();
    expect(() => resolveRecordingPath('active/shared/tmp/not-a-recording.json', tmpRoot)).toThrow(
      /must be under active\/shared\/runtime\/recordings/
    );
  });
});

// ---------------------------------------------------------------------------
// promote (pipeline plan; mission --execute is out of scope for a unit test)
// ---------------------------------------------------------------------------

describe('inventory promote (hermetic)', () => {
  function pipelineBoundEntry(): WorkInventoryEntry {
    const step: WorkInventoryStep = {
      step_id: 'S1',
      stage: 'act',
      verb: 'operate',
      description: 'run the reporting pipeline',
      data_sensitivity: 'internal',
      effects: [],
      method: { assigned: 'program', source: 'rule', rationale: 'seed' },
      binding: { pipeline_id: 'monthly-report' },
    };
    const draft = createWorkInventoryEntry(
      {
        title: 'Promotable',
        scope: {},
        trigger: { kind: 'schedule', description: 'monthly' },
        steps: [step],
      },
      NOW
    );
    const classified = applyClassification(draft, {});
    return saveWorkInventoryEntry({ ...classified, status: 'candidate' }, { rootDir: tmpRoot });
  }

  it('requires --decided-by before planning', () => {
    const entry = pipelineBoundEntry();
    expect(() => runPromote(entry.entry_id, ['promote', '--kind', 'mission'], opts)).toThrow(
      WorkInventoryCliUsageError
    );
  });

  it('plans a pipeline promotion and never executes it', () => {
    const entry = pipelineBoundEntry();
    const result: PromoteResult = runPromote(
      entry.entry_id,
      ['promote', '--kind', 'pipeline', '--decided-by', 'user:alice'],
      opts
    );
    expect(result.plan.kind).toBe('pipeline');
    expect(result.executed).toBe(false);
    expect(result.pipeline_command).toContain('pipeline:promote');
    expect(result.pipeline_command).toContain('monthly-report');
  });
});

// ---------------------------------------------------------------------------
// learn (dry-run preview only; the real cycle is exercised via core tests)
// ---------------------------------------------------------------------------

describe('inventory learn (hermetic)', () => {
  it('measures only runs after promoted_at (pre-promotion failures never count)', () => {
    const promotedAt = '2026-09-10T00:00:00.000Z';
    const draft = createWorkInventoryEntry(
      {
        title: 'Monthly report',
        scope: {},
        trigger: { kind: 'schedule', description: 'monthly' },
        effort_minutes_per_run: 30,
        steps: [
          {
            step_id: 'S1',
            stage: 'act',
            verb: 'transform',
            description: 'build the report',
            data_sensitivity: 'internal',
            effects: [],
            method: { assigned: 'program', source: 'rule', rationale: 'seed' },
            binding: { pipeline_id: 'monthly-report' },
          },
        ],
      },
      NOW
    );
    saveWorkInventoryEntry(
      {
        ...draft,
        status: 'promoted',
        promotion: {
          kind: 'pipeline',
          ref: 'monthly-report',
          promoted_at: promotedAt,
          decided_by: { kind: 'human', id: 'user:alice' },
        },
      },
      { rootDir: tmpRoot }
    );
    const tracesDir = path.join(tmpRoot, 'active/shared/logs/traces');
    safeMkdir(tracesDir, { recursive: true });
    const trace = (id: string, at: string, status: 'ok' | 'error') =>
      JSON.stringify({
        traceId: id,
        rootSpan: { name: 'pipeline:monthly-report', status },
        metadata: { startedAt: at },
      });
    safeWriteFile(
      path.join(tracesDir, 'traces-2026-09-05.jsonl'),
      [
        // Before the promotion: manual runs that failed.
        trace('pre-1', '2026-09-05T01:00:00.000Z', 'error'),
        trace('pre-2', '2026-09-05T02:00:00.000Z', 'error'),
        trace('pre-3', '2026-09-05T03:00:00.000Z', 'error'),
        // After the promotion: the automation succeeded.
        trace('post-1', '2026-09-15T01:00:00.000Z', 'ok'),
        trace('post-2', '2026-09-16T01:00:00.000Z', 'ok'),
      ].join('\n')
    );

    const result = runLearn(['learn', '--dry-run', '--days', '28'], { ...opts, dryRun: true });
    expect(result.measured).toBe(1);
    // Post-promotion runs never failed: nothing to calibrate, no gap to report.
    expect(result.calibrated_methods).toEqual([]);
    expect(result.learning_signals).toEqual([]);
  });

  it('dry-run previews without persisting anything against an empty fixture root', () => {
    const result = runLearn(['learn', '--dry-run', '--days', '7'], { ...opts, dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.measured).toBe(0);
    expect(result.calibrated_methods).toEqual([]);
    expect(result.enqueued).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dispatcher (run()) — end-to-end argv parsing through the CLI surface
// ---------------------------------------------------------------------------

describe('inventory dispatcher end-to-end (hermetic)', () => {
  it('runs add -> list -> show -> override -> status -> candidates through argv', async () => {
    const printed: unknown[] = [];
    const print = (value: unknown) => printed.push(value);

    await run(
      ['add', '--title', 'E2E entry', '--steps', 'Slackで確認する', '--no-model', '--json'],
      { rootDir: tmpRoot, now: NOW, print }
    );
    const addResult = printed.at(-1) as AddResult;
    const entryId = addResult.entry.entry_id;
    expect(entryId).toMatch(/^WI-/);

    await run(['list', '--json'], { rootDir: tmpRoot, print });
    const listResult = printed.at(-1) as { entries: WorkInventoryEntry[] };
    expect(listResult.entries.map((e) => e.entry_id)).toContain(entryId);

    await run(['show', entryId, '--json'], { rootDir: tmpRoot, print });
    const showResult = printed.at(-1) as ShowResult;
    expect(showResult.entry.entry_id).toBe(entryId);
    const stepId = showResult.entry.steps[0].step_id;

    await run(
      [
        'override',
        entryId,
        '--step',
        stepId,
        '--method',
        'human',
        '--reason',
        'needs judgement',
        '--decided-by',
        'user:alice',
        '--json',
      ],
      { rootDir: tmpRoot, print }
    );
    const overridden = printed.at(-1) as WorkInventoryEntry;
    expect(overridden.steps.find((s) => s.step_id === stepId)?.method.source).toBe(
      'human_override'
    );

    await run(['status', entryId, '--to', 'candidate', '--decided-by', 'user:alice', '--json'], {
      rootDir: tmpRoot,
      print,
    });
    expect((printed.at(-1) as WorkInventoryEntry).status).toBe('candidate');

    await run(['candidates', '--json'], { rootDir: tmpRoot, print });
    const candidatesResult = printed.at(-1) as { candidates: WorkInventoryScoreResult[] };
    expect(candidatesResult.candidates.some((c) => c.entry_id === entryId)).toBe(true);
  });

  it('rejects an unknown subcommand', async () => {
    await expect(run(['bogus'], { rootDir: tmpRoot })).rejects.toThrow(WorkInventoryCliUsageError);
  });

  it('formats human-readable text when --json is absent', async () => {
    const printed: unknown[] = [];
    const print = (value: unknown) => printed.push(value);
    await run(['add', '--title', 'Human readable'], { rootDir: tmpRoot, now: NOW, print });
    expect(typeof printed.at(-1)).toBe('string');
    expect(String(printed.at(-1))).toContain('Steps:');
  });

  it('runs migrate through argv and reports the entries it changed', async () => {
    const entry = legacyOcrBindingEntry('E2E migrate entry');
    saveWorkInventoryEntry(entry, { rootDir: tmpRoot });

    const printed: unknown[] = [];
    const print = (value: unknown) => printed.push(value);
    await run(['migrate', '--json'], { rootDir: tmpRoot, print });
    const result = printed.at(-1) as {
      results: Array<{ entry_id: string }>;
      total_changed: number;
    };
    expect(result.total_changed).toBe(1);
    expect(result.results.map((r) => r.entry_id)).toEqual([entry.entry_id]);

    await run(['migrate'], { rootDir: tmpRoot, print });
    expect(String(printed.at(-1))).toContain('bindings marked inferred: 0');
  });
});
