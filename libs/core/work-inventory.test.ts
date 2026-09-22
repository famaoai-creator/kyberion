import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync } from './secure-io.js';
import {
  applyClassification,
  classifyWorkStep,
  createWorkInventoryEntry,
  forcedHumanEffects,
  listWorkInventoryEntries,
  loadWorkInventoryEntry,
  loadWorkInventoryTaxonomy,
  migrateInferredBindings,
  saveWorkInventoryEntry,
  validateWorkInventoryEntry,
  workInventoryRoot,
  WorkInventoryStoreError,
  type WorkInventoryEntry,
  type WorkInventoryStep,
} from './work-inventory.js';

function step(overrides: Partial<WorkInventoryStep> = {}): WorkInventoryStep {
  return {
    step_id: 'S1',
    stage: 'act',
    verb: 'input',
    description: 'do the thing',
    data_sensitivity: 'internal',
    effects: [],
    method: { assigned: 'human', source: 'proposal', rationale: 'initial guess' },
    ...overrides,
  };
}

describe('work inventory taxonomy', () => {
  it('loads and validates the governed catalog', () => {
    const taxonomy = loadWorkInventoryTaxonomy();
    expect(taxonomy.stages).toHaveLength(7);
    expect(taxonomy.verbs).toHaveLength(12);
    expect(taxonomy.methods).toHaveLength(5);
    expect(taxonomy.effects).toHaveLength(5);
    expect(taxonomy.rules.length).toBeGreaterThan(0);
    expect(taxonomy.rules[taxonomy.rules.length - 1].when).toEqual({});
  });
});

describe('classifyWorkStep', () => {
  it('forces human for a money effect even on a transform verb', () => {
    const result = classifyWorkStep({
      verb: 'transform',
      stage: 'act',
      effects: ['money'],
      data_sensitivity: 'internal',
    });
    expect(result.method).toBe('human');
    expect(result.rule_id).toBe('effects-force-human');
  });

  it('assigns api to input when the system already has one', () => {
    const result = classifyWorkStep(
      { verb: 'input', stage: 'act', effects: [], data_sensitivity: 'internal' },
      { system_has_api: true }
    );
    expect(result.method).toBe('api');
    expect(result.rule_id).toBe('api-verbs-with-system-api');
  });

  it('assigns computer_operation to input when the system has no api', () => {
    const result = classifyWorkStep(
      { verb: 'input', stage: 'act', effects: [], data_sensitivity: 'internal' },
      { system_has_api: false }
    );
    expect(result.method).toBe('computer_operation');
    expect(result.rule_id).toBe('no-api-ui-operation');
  });

  it('assigns ai_reasoning to read', () => {
    const result = classifyWorkStep({
      verb: 'read',
      stage: 'understand',
      effects: [],
      data_sensitivity: 'internal',
    });
    expect(result.method).toBe('ai_reasoning');
    expect(result.rule_id).toBe('reasoning-verbs');
  });

  it('assigns program to transform', () => {
    const result = classifyWorkStep({
      verb: 'transform',
      stage: 'act',
      effects: [],
      data_sensitivity: 'internal',
    });
    expect(result.method).toBe('program');
    expect(result.rule_id).toBe('transform-to-program');
  });

  it('routes UI operation to the api when the system has an API', () => {
    const result = classifyWorkStep(
      { verb: 'operate', stage: 'act', effects: [], data_sensitivity: 'internal' },
      { system_has_api: true }
    );
    expect(result.method).toBe('api');
    expect(result.rule_id).toBe('api-verbs-with-system-api');
  });

  it('routes messaging without an API to computer operation', () => {
    const result = classifyWorkStep({
      verb: 'communicate',
      stage: 'act',
      effects: [],
      data_sensitivity: 'internal',
    });
    expect(result.method).toBe('computer_operation');
    expect(result.rule_id).toBe('no-api-ui-operation');
  });

  it('falls back to human when no specific rule matches', () => {
    const taxonomy = loadWorkInventoryTaxonomy();
    const onlyFallback = {
      ...taxonomy,
      rules: taxonomy.rules.filter((rule) => rule.rule_id === 'fallback-to-human'),
    };
    const result = classifyWorkStep(
      { verb: 'operate', stage: 'act', effects: [], data_sensitivity: 'internal' },
      { system_has_api: true },
      onlyFallback
    );
    expect(result.method).toBe('human');
    expect(result.rule_id).toBe('fallback-to-human');
  });

  it('flags requires_review for external_send regardless of the winning method', () => {
    const result = classifyWorkStep({
      verb: 'read',
      stage: 'understand',
      effects: ['external_send'],
      data_sensitivity: 'internal',
    });
    expect(result.method).toBe('ai_reasoning');
    expect(result.requires_review).toBe(true);
  });

  it('does not flag requires_review when no review effect is present', () => {
    const result = classifyWorkStep({
      verb: 'read',
      stage: 'understand',
      effects: [],
      data_sensitivity: 'internal',
    });
    expect(result.requires_review).toBe(false);
  });
});

describe('applyClassification', () => {
  it('preserves a human_override method but recomputes requires_review and binding', () => {
    const entry: WorkInventoryEntry = {
      schema_version: 'work-inventory.v1',
      entry_id: 'WI-20260922-test',
      title: 'test',
      scope: {},
      trigger: { kind: 'ad_hoc', description: 'test' },
      steps: [
        step({
          verb: 'transform',
          effects: ['personal_data'],
          method: {
            assigned: 'ai_reasoning',
            source: 'human_override',
            rationale: 'human said so',
          },
        }),
      ],
      status: 'draft',
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    };
    const result = applyClassification(entry);
    expect(result.steps[0].method).toEqual({
      assigned: 'ai_reasoning',
      source: 'human_override',
      rationale: 'human said so',
    });
    expect(result.steps[0].requires_review).toBe(true);
    expect(result.steps[0].binding?.actuator).toBe('artifact-actuator');
  });

  it('overrides a mismatched proposal and records both in the rationale', () => {
    const entry: WorkInventoryEntry = {
      schema_version: 'work-inventory.v1',
      entry_id: 'WI-20260922-test2',
      title: 'test2',
      scope: {},
      trigger: { kind: 'ad_hoc', description: 'test' },
      steps: [
        step({
          verb: 'transform',
          method: {
            assigned: 'ai_reasoning',
            source: 'proposal',
            rationale: 'looked reasoning-like',
          },
        }),
      ],
      status: 'draft',
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    };
    const result = applyClassification(entry);
    const method = result.steps[0].method;
    expect(method.assigned).toBe('program');
    expect(method.source).toBe('rule');
    expect(method.rule_id).toBe('transform-to-program');
    expect(method.rationale).toContain('rule transform-to-program');
    expect(method.rationale).toContain('proposal was ai_reasoning: looked reasoning-like');
  });

  it('fills binding.actuator from the verb default when binding is absent', () => {
    const entry: WorkInventoryEntry = {
      schema_version: 'work-inventory.v1',
      entry_id: 'WI-20260922-test3',
      title: 'test3',
      scope: {},
      trigger: { kind: 'ad_hoc', description: 'test' },
      steps: [step({ verb: 'read' })],
      status: 'draft',
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    };
    const result = applyClassification(entry);
    expect(result.steps[0].binding?.actuator).toBe('vision-actuator');
    expect(result.steps[0].binding?.op).toBe('ocr_image');
    // A filled default is a hint, never a declared binding.
    expect(result.steps[0].binding?.inferred).toBe(true);
    expect(validateWorkInventoryEntry(result).valid).toBe(true);
  });

  it('keeps an explicit binding un-inferred', () => {
    const entry: WorkInventoryEntry = {
      schema_version: 'work-inventory.v1',
      entry_id: 'WI-20260922-test4',
      title: 'test4',
      scope: {},
      trigger: { kind: 'ad_hoc', description: 'test' },
      steps: [
        step({ verb: 'read', binding: { actuator: 'wisdom-actuator', op: 'knowledge_read' } }),
      ],
      status: 'draft',
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    };
    expect(applyClassification(entry).steps[0].binding).toEqual({
      actuator: 'wisdom-actuator',
      op: 'knowledge_read',
    });
  });

  it('rejects a non-human override on a money/irreversible/approval step; the rule wins', () => {
    const taxonomy = loadWorkInventoryTaxonomy();
    expect(forcedHumanEffects(taxonomy)).toEqual(['money', 'irreversible', 'approval']);
    const entry: WorkInventoryEntry = {
      schema_version: 'work-inventory.v1',
      entry_id: 'WI-20260922-test5',
      title: 'test5',
      scope: {},
      trigger: { kind: 'ad_hoc', description: 'test' },
      steps: [
        step({
          verb: 'operate',
          effects: ['money'],
          method: { assigned: 'api', source: 'human_override', rationale: 'just pay it' },
        }),
        step({
          step_id: 'S2',
          verb: 'judge',
          effects: ['approval'],
          method: { assigned: 'human', source: 'human_override', rationale: 'I sign off' },
        }),
      ],
      status: 'draft',
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    };
    const [paid, approved] = applyClassification(entry, {}, taxonomy).steps;
    expect(paid.method.assigned).toBe('human');
    expect(paid.method.source).toBe('rule');
    expect(paid.method.rule_id).toBe('effects-force-human');
    expect(paid.method.rationale).toContain('rejected human_override to api');
    expect(paid.method.rationale).toContain('just pay it');
    // A human override on the same kind of step stands.
    expect(approved.method).toEqual({
      assigned: 'human',
      source: 'human_override',
      rationale: 'I sign off',
    });
  });

  it('reads the forced-human effects from the taxonomy, not a hardcoded list', () => {
    const taxonomy = loadWorkInventoryTaxonomy();
    expect(forcedHumanEffects({ ...taxonomy, forced_human_effects: ['personal_data'] })).toEqual([
      'personal_data',
    ]);
    const { forced_human_effects: _omitted, ...withoutField } = taxonomy;
    expect(forcedHumanEffects(withoutField)).toEqual(['money', 'irreversible', 'approval']);
  });
});

// WI-17: verb 'read''s first taxonomy candidate is {actuator: 'vision-actuator',
// op: 'ocr_image'} (see the applyClassification suite above).
describe('migrateInferredBindings', () => {
  function entryWithBinding(
    binding: WorkInventoryStep['binding'],
    extraSteps: WorkInventoryStep[] = []
  ): WorkInventoryEntry {
    return {
      schema_version: 'work-inventory.v1',
      entry_id: 'WI-20260922-migrate-test',
      title: 'migrate test',
      scope: {},
      trigger: { kind: 'ad_hoc', description: 'test' },
      steps: [step({ verb: 'read', binding }), ...extraSteps],
      status: 'draft',
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    };
  }

  it('marks inferred: true on a legacy binding matching the default candidate and lacking inferred', () => {
    const entry = entryWithBinding({ actuator: 'vision-actuator', op: 'ocr_image' });
    const { entry: migrated, changed } = migrateInferredBindings(entry);
    expect(changed).toBe(1);
    expect(migrated.steps[0].binding).toEqual({
      actuator: 'vision-actuator',
      op: 'ocr_image',
      inferred: true,
    });
  });

  it('leaves an explicit binding that differs from the default candidate untouched', () => {
    const entry = entryWithBinding({ actuator: 'wisdom-actuator', op: 'knowledge_read' });
    const { entry: migrated, changed } = migrateInferredBindings(entry);
    expect(changed).toBe(0);
    expect(migrated).toBe(entry); // untouched: same reference, not a rebuilt copy
    expect(migrated.steps[0].binding).toEqual({
      actuator: 'wisdom-actuator',
      op: 'knowledge_read',
    });
  });

  it('leaves a default-matching binding untouched when it carries a pipeline_id or intent_id', () => {
    const withPipeline = entryWithBinding({
      actuator: 'vision-actuator',
      op: 'ocr_image',
      pipeline_id: 'some-pipeline',
    });
    expect(migrateInferredBindings(withPipeline).changed).toBe(0);

    const withIntent = entryWithBinding({
      actuator: 'vision-actuator',
      op: 'ocr_image',
      intent_id: 'some-intent',
    });
    expect(migrateInferredBindings(withIntent).changed).toBe(0);
  });

  it('leaves a binding that already carries an inferred key untouched (true or explicit false)', () => {
    const alreadyTrue = entryWithBinding({
      actuator: 'vision-actuator',
      op: 'ocr_image',
      inferred: true,
    });
    expect(migrateInferredBindings(alreadyTrue).changed).toBe(0);

    // An explicit `inferred: false` means a person confirmed this binding
    // deliberately even though it happens to match the default — migration
    // must never flip that back to true.
    const explicitFalse = entryWithBinding({
      actuator: 'vision-actuator',
      op: 'ocr_image',
      inferred: false,
    });
    const { entry: migrated, changed } = migrateInferredBindings(explicitFalse);
    expect(changed).toBe(0);
    expect(migrated.steps[0].binding?.inferred).toBe(false);
  });

  it('leaves a step with no binding at all untouched', () => {
    const entry = entryWithBinding(undefined);
    const { entry: migrated, changed } = migrateInferredBindings(entry);
    expect(changed).toBe(0);
    expect(migrated).toBe(entry);
  });

  it('touches only the matching steps and sums changed across the entry', () => {
    const entry = entryWithBinding(
      { actuator: 'vision-actuator', op: 'ocr_image' }, // S1: matches -> migrated
      [
        step({
          step_id: 'S2',
          verb: 'read',
          binding: { actuator: 'wisdom-actuator', op: 'knowledge_read' }, // explicit -> untouched
        }),
        step({
          step_id: 'S3',
          verb: 'read',
          binding: { actuator: 'vision-actuator', op: 'ocr_image' }, // matches -> migrated
        }),
      ]
    );
    const { entry: migrated, changed } = migrateInferredBindings(entry);
    expect(changed).toBe(2);
    expect(migrated.steps[0].binding?.inferred).toBe(true);
    expect(migrated.steps[1].binding).toEqual({
      actuator: 'wisdom-actuator',
      op: 'knowledge_read',
    });
    expect(migrated.steps[2].binding?.inferred).toBe(true);
  });

  it('is idempotent: a second run over the migrated entry changes nothing', () => {
    const entry = entryWithBinding({ actuator: 'vision-actuator', op: 'ocr_image' });
    const first = migrateInferredBindings(entry);
    expect(first.changed).toBe(1);
    const second = migrateInferredBindings(first.entry);
    expect(second.changed).toBe(0);
    expect(second.entry).toBe(first.entry);
  });
});

describe('validateWorkInventoryEntry', () => {
  const base: WorkInventoryEntry = {
    schema_version: 'work-inventory.v1',
    entry_id: 'WI-20260922-valid',
    title: 'valid entry',
    scope: {},
    trigger: { kind: 'ad_hoc', description: 'test' },
    steps: [],
    status: 'draft',
    created_at: '2026-09-22T00:00:00.000Z',
    updated_at: '2026-09-22T00:00:00.000Z',
  };

  it('accepts a well-formed entry', () => {
    expect(validateWorkInventoryEntry(base)).toEqual({ valid: true, errors: [] });
  });

  it('rejects an invalid enum value', () => {
    const invalid = { ...base, status: 'not-a-real-status' };
    const result = validateWorkInventoryEntry(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects an unexpected top-level property', () => {
    const invalid = { ...base, unexpected_field: 'nope' };
    const result = validateWorkInventoryEntry(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('additional'))).toBe(true);
  });
});

describe('createWorkInventoryEntry', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');

  it('is deterministic for the same title and timestamp', () => {
    const first = createWorkInventoryEntry(
      {
        title: 'Weekly invoice review',
        scope: {},
        trigger: { kind: 'schedule', description: 'weekly' },
      },
      now
    );
    const second = createWorkInventoryEntry(
      {
        title: 'Weekly invoice review',
        scope: {},
        trigger: { kind: 'schedule', description: 'weekly' },
      },
      now
    );
    expect(first.entry_id).toBe(second.entry_id);
    expect(first.entry_id).toMatch(/^WI-20260922-/);
    expect(first.status).toBe('draft');
    expect(first.steps).toEqual([]);
  });

  it('is deterministic even for a non-ASCII (Japanese) title', () => {
    const first = createWorkInventoryEntry(
      {
        title: '週次請求書レビュー',
        scope: {},
        trigger: { kind: 'schedule', description: 'weekly' },
      },
      now
    );
    const second = createWorkInventoryEntry(
      {
        title: '週次請求書レビュー',
        scope: {},
        trigger: { kind: 'schedule', description: 'weekly' },
      },
      now
    );
    expect(first.entry_id).toBe(second.entry_id);
    expect(first.entry_id).toMatch(/^WI-[A-Za-z0-9_-]{3,80}$/);
  });
});

describe('createWorkInventoryEntry ids', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');
  const make = (title: string, scope: WorkInventoryEntry['scope'] = {}, at = now) =>
    createWorkInventoryEntry({ title, scope, trigger: { kind: 'ad_hoc', description: 't' } }, at);

  it('never collides for two titles whose ASCII slug is the same', () => {
    const expense = make('経費精算 Excel');
    const sales = make('売上集計 Excel');
    expect(expense.entry_id).not.toBe(sales.entry_id);
    expect(expense.entry_id).toMatch(/^WI-20260922-excel-[0-9a-f]{8}$/);
    expect(sales.entry_id).toMatch(/^WI-20260922-excel-[0-9a-f]{8}$/);
  });

  it('separates scopes and creation times, and omits an empty slug', () => {
    expect(make('Excel').entry_id).not.toBe(make('Excel', { tenant_slug: 'acme-corp' }).entry_id);
    expect(make('Excel').entry_id).not.toBe(
      make('Excel', {}, new Date('2026-09-22T12:00:01.000Z')).entry_id
    );
    expect(make('経費精算').entry_id).toMatch(/^WI-20260922-[0-9a-f]{8}$/);
    const long = make('x'.repeat(200)).entry_id;
    expect(long).toMatch(/^WI-[A-Za-z0-9_-]{3,80}$/);
    expect(long).toBe(`WI-20260922-${'x'.repeat(40)}-${long.slice(-8)}`);
  });
});

describe('work inventory storage (hermetic)', () => {
  const FIXTURE_PARENT = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp');
  let fixtureRoot = '';

  beforeEach(() => {
    fixtureRoot = path.join(FIXTURE_PARENT, `work-inventory-test-${randomUUID()}`);
    safeMkdir(fixtureRoot, { recursive: true });
  });

  afterEach(() => {
    if (fixtureRoot && safeExistsSync(fixtureRoot)) {
      safeRmSync(fixtureRoot, { recursive: true, force: true });
    }
    fixtureRoot = '';
  });

  it('create mode refuses to overwrite an existing entry; upsert still updates', () => {
    const now = new Date('2026-09-22T12:00:00.000Z');
    const entry = createWorkInventoryEntry(
      { title: 'Monthly close', scope: {}, trigger: { kind: 'schedule', description: 'monthly' } },
      now
    );
    saveWorkInventoryEntry(entry, { rootDir: fixtureRoot, mode: 'create' });
    let caught: unknown;
    try {
      saveWorkInventoryEntry(
        { ...entry, title: 'Other work' },
        {
          rootDir: fixtureRoot,
          mode: 'create',
        }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkInventoryStoreError);
    expect((caught as WorkInventoryStoreError).code).toBe('WORK_INVENTORY_ENTRY_EXISTS');
    expect(loadWorkInventoryEntry({}, entry.entry_id, { rootDir: fixtureRoot })?.title).toBe(
      'Monthly close'
    );
    saveWorkInventoryEntry({ ...entry, status: 'confirmed' }, { rootDir: fixtureRoot });
    expect(loadWorkInventoryEntry({}, entry.entry_id, { rootDir: fixtureRoot })?.status).toBe(
      'confirmed'
    );
  });

  it('rejects a reserved scope name as a tenant slug', () => {
    expect(() => workInventoryRoot({ tenant_slug: 'confidential' }, fixtureRoot)).toThrow(
      'invalid tenant slug'
    );
  });

  it('round-trips a tenant-scoped entry through save/load/list', () => {
    const now = new Date('2026-09-22T12:00:00.000Z');
    const entry = createWorkInventoryEntry(
      {
        title: 'Monthly close',
        scope: { tenant_slug: 'acme-corp' },
        trigger: { kind: 'schedule', description: 'monthly' },
      },
      now
    );
    const saved = saveWorkInventoryEntry(entry, { rootDir: fixtureRoot });
    expect(saved.updated_at).toBeTruthy();

    const loaded = loadWorkInventoryEntry(entry.scope, entry.entry_id, { rootDir: fixtureRoot });
    expect(loaded?.entry_id).toBe(entry.entry_id);
    expect(loaded?.title).toBe('Monthly close');

    const listed = listWorkInventoryEntries(entry.scope, { rootDir: fixtureRoot });
    expect(listed.map((item) => item.entry_id)).toEqual([entry.entry_id]);

    const root = workInventoryRoot(entry.scope, fixtureRoot);
    expect(root).toBe(path.join(fixtureRoot, 'knowledge/confidential/acme-corp/work-inventory'));
  });

  it('round-trips a personal-scoped entry when no tenant is set', () => {
    const now = new Date('2026-09-22T12:00:00.000Z');
    const entry = createWorkInventoryEntry(
      {
        title: 'Personal triage',
        scope: {},
        trigger: { kind: 'ad_hoc', description: 'as needed' },
      },
      now
    );
    saveWorkInventoryEntry(entry, { rootDir: fixtureRoot });
    const loaded = loadWorkInventoryEntry({}, entry.entry_id, { rootDir: fixtureRoot });
    expect(loaded?.entry_id).toBe(entry.entry_id);
    expect(workInventoryRoot({}, fixtureRoot)).toBe(
      path.join(fixtureRoot, 'knowledge/personal/work-inventory')
    );
  });

  it('returns null when loading a missing entry and [] when listing an empty scope', () => {
    expect(
      loadWorkInventoryEntry({ tenant_slug: 'acme-corp' }, 'WI-20260922-missing', {
        rootDir: fixtureRoot,
      })
    ).toBeNull();
    expect(
      listWorkInventoryEntries({ tenant_slug: 'acme-corp' }, { rootDir: fixtureRoot })
    ).toEqual([]);
  });

  it('refuses to save an entry that fails schema validation', () => {
    const invalid = {
      schema_version: 'work-inventory.v1',
      entry_id: 'WI-20260922-bad',
      title: 'bad',
      scope: {},
      trigger: { kind: 'ad_hoc', description: 'test' },
      steps: [],
      status: 'not-a-status',
      created_at: '2026-09-22T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    } as unknown as WorkInventoryEntry;
    expect(() => saveWorkInventoryEntry(invalid, { rootDir: fixtureRoot })).toThrow(
      /Invalid work inventory entry/
    );
  });
});
