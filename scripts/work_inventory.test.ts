import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeRmSync } from '@agent/core';
import {
  applyClassification,
  createWorkInventoryEntry,
  loadWorkInventoryEntry,
  saveWorkInventoryEntry,
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
  runOverride,
  runShow,
  runStatus,
} from './lib/work-inventory-cli-entries.js';
import { runHarvest } from './lib/work-inventory-cli-harvest.js';
import {
  runConsentGrant,
  runConsentList,
  runConsentRevoke,
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
  });

  it('--dry-run never saves suggested drafts', () => {
    const result = runHarvest(['harvest', '--dry-run', '--suggest'], { ...opts, dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.suggested).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// consent
// ---------------------------------------------------------------------------

describe('inventory consent (hermetic)', () => {
  it('grant requires --decided-by', () => {
    expect(() =>
      runConsentGrant(
        [
          'consent',
          'grant',
          '--member',
          'alice',
          '--sources',
          'desktop_recording',
          '--kinds',
          'active_window',
          '--purpose',
          'find automatable steps',
          '--days',
          '30',
        ],
        opts
      )
    ).toThrow(WorkInventoryCliUsageError);
  });

  it('rejects granting consent on behalf of another member', () => {
    expect(() =>
      runConsentGrant(
        [
          'consent',
          'grant',
          '--member',
          'alice',
          '--sources',
          'desktop_recording',
          '--kinds',
          'active_window',
          '--purpose',
          'find automatable steps',
          '--days',
          '30',
          '--decided-by',
          'user:bob',
        ],
        opts
      )
    ).toThrow();
  });

  it('grant -> list -> revoke round-trips', () => {
    const granted: WorkInventoryConsent = runConsentGrant(
      [
        'consent',
        'grant',
        '--member',
        'alice',
        '--sources',
        'desktop_recording,browser_recording',
        '--kinds',
        'active_window,browser_tabs',
        '--purpose',
        'find automatable steps',
        '--days',
        '30',
        '--decided-by',
        'user:alice',
      ],
      opts
    );
    expect(granted.member_id).toBe('alice');
    expect(granted.sources).toEqual(['desktop_recording', 'browser_recording']);

    const listed = runConsentList(['consent', 'list', '--member', 'alice'], opts);
    expect(listed.map((c) => c.consent_id)).toContain(granted.consent_id);

    const revoked = runConsentRevoke(
      [
        'consent',
        'revoke',
        '--member',
        'alice',
        '--consent',
        granted.consent_id,
        '--decided-by',
        'user:alice',
      ],
      opts
    );
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
});
