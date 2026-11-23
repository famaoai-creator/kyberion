import * as path from 'node:path';
import { safeReadFile } from '../secure-io.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_MIGRATION_EVIDENCE_FILES,
  LEGACY_MIGRATION_SOURCE_SNAPSHOT_FILE,
  validateLegacyMigrationEvidenceAt,
  writeLegacyMigrationSourceSnapshot,
} from './legacy-migration-evidence.js';
import { cleanupFixtures, reverseSpecFixture, write } from './__tests__/reverse-spec-fixture.js';

afterEach(cleanupFixtures);

const SOURCE_MISSION_ID = 'MSN-LEGACY-SPEC-FIXTURE';

/** A passing legacy_migration evidence set seeded by an audited rebuild-purpose reverse_spec fixture. */
function migrationFixture(purpose: 'rebuild' | 'evaluation' = 'rebuild') {
  const spec = reverseSpecFixture(purpose);
  const mission = path.join(spec.base, 'migration');
  const docs = {
    brief: {
      source_spec_mission_id: SOURCE_MISSION_ID,
      objective: 'Retire the Java monolith',
      success_metrics: ['all parity scenarios pass'],
      target_stack: { language: 'typescript', framework: 'next.js' },
      scope: { included: ['ordering'], excluded: [] },
    } as Record<string, unknown>,
    decisions: {
      paradigm: {
        legacy: 'server-rendered MVC',
        target: 'SPA + API',
        gap: 'session state moves client-side',
      },
      dispositions: [
        { spec_id: 'SPEC-BEHAVIOR-ordering-01', disposition: 'migrate', reason: 'core rule' },
      ],
      strategy: {
        selected: 'strangler_fig',
        alternatives: ['big_bang'],
        rationale: 'incremental cut-over',
      },
    } as Record<string, unknown>,
    pin: {
      scenarios: [
        {
          scenario_id: 'PAR-001',
          spec_id: 'SPEC-BEHAVIOR-ordering-01',
          kind: 'gherkin',
          path: 'evidence/parity/ordering.feature',
          legacy_result: 'pass',
        },
      ],
    } as Record<string, unknown>,
    equivalence: { results: [{ scenario_id: 'PAR-001', target_result: 'pass' }] } as Record<
      string,
      unknown
    >,
  };
  const flush = () => {
    for (const [stage, doc] of Object.entries(docs))
      write(path.join(mission, LEGACY_MIGRATION_EVIDENCE_FILES[stage as keyof typeof docs]), doc);
    write(path.join(mission, 'evidence/parity/ordering.feature'), 'Feature: ordering discount\n');
    write(
      path.join(mission, LEGACY_MIGRATION_EVIDENCE_FILES.implement),
      '# Migration report\nEach spec was rebuilt; every parity scenario ran green on the target.\n'
    );
  };
  flush();
  const options = {
    resolveMissionDir: (id: string) => {
      if (id !== SOURCE_MISSION_ID) throw new Error(`mission directory not found for ${id}`);
      return spec.mission;
    },
  };
  // Freeze the source spec at the brief, as the operator does with --write-source-snapshot.
  if (purpose === 'rebuild') writeLegacyMigrationSourceSnapshot(mission, options);
  return { mission, docs, flush, options, spec };
}

describe('legacy_migration evidence gates', () => {
  it('passes every stage for a complete evidence set bound to an audited rebuild spec', () => {
    const { mission, options } = migrationFixture();
    for (const stage of ['brief', 'decisions', 'pin', 'implement', 'equivalence'] as const) {
      expect(validateLegacyMigrationEvidenceAt(mission, stage, options).ok).toBe(true);
    }
  });

  it('refuses a brief whose source spec is not rebuild-purpose or no longer passes its audit', () => {
    const evaluation = migrationFixture('evaluation');
    expect(() =>
      validateLegacyMigrationEvidenceAt(evaluation.mission, 'brief', evaluation.options)
    ).toThrow(/purpose rebuild/u);
    const broken = migrationFixture();
    broken.spec.docs.audit.entries = [];
    broken.spec.flush();
    expect(() =>
      validateLegacyMigrationEvidenceAt(broken.mission, 'brief', broken.options)
    ).toThrow(/does not pass its audit/u);
  });

  it('freezes the source audit at the brief so an in-place rebuild of the legacy tree can proceed', () => {
    const { mission, options, spec } = migrationFixture();
    expect(validateLegacyMigrationEvidenceAt(mission, 'brief', options).ok).toBe(true);
    write(
      path.join(spec.source, 'src/billing.py'),
      'def charge(amount):\n    return round(amount)\n'
    );
    expect(() => validateLegacyMigrationEvidenceAt(mission, 'brief', options)).toThrow(
      /does not pass its audit/u
    );
    for (const stage of ['decisions', 'pin', 'equivalence'] as const) {
      expect(validateLegacyMigrationEvidenceAt(mission, stage, options).ok).toBe(true);
    }
  });

  it('requires a current source-spec snapshot at the brief and reads later stages from it', () => {
    const { mission, options, spec } = migrationFixture();
    const snapshotPath = path.join(mission, LEGACY_MIGRATION_SOURCE_SNAPSHOT_FILE);
    // Later stages need neither the source mission nor its live ledger.
    const unreachable = {
      resolveMissionDir: () => {
        throw new Error('source mission archived');
      },
    };
    expect(validateLegacyMigrationEvidenceAt(mission, 'decisions', unreachable).ok).toBe(true);
    // The verifier re-records an entry after the freeze: the brief sees a stale snapshot.
    spec.docs.audit.entries = [{ claim_id: 'C-001', verdict: 'supported', note: 're-checked' }];
    spec.flush();
    expect(() => validateLegacyMigrationEvidenceAt(mission, 'brief', options)).toThrow(
      /source snapshot does not match the source mission/u
    );
    writeLegacyMigrationSourceSnapshot(mission, options);
    expect(validateLegacyMigrationEvidenceAt(mission, 'brief', options).ok).toBe(true);
    write(snapshotPath, {
      kind: 'legacy-migration-source-spec-snapshot',
      source_spec_mission_id: 'MSN-OTHER',
    });
    expect(() => validateLegacyMigrationEvidenceAt(mission, 'decisions', options)).toThrow(
      /source snapshot is for MSN-OTHER/u
    );
  });

  it('rejects a snapshot whose spec list was edited even when its hashes are copied', () => {
    const { mission, options } = migrationFixture();
    const snapshotPath = path.join(mission, LEGACY_MIGRATION_SOURCE_SNAPSHOT_FILE);
    const snapshot = JSON.parse(String(safeReadFile(snapshotPath, { encoding: 'utf8' })));
    snapshot.specs = [];
    write(snapshotPath, snapshot);
    expect(() => validateLegacyMigrationEvidenceAt(mission, 'brief', options)).toThrow(
      /source snapshot does not match the source mission/u
    );
  });

  it('refuses to freeze a source spec that does not pass its audit', () => {
    const { mission, options, spec } = migrationFixture();
    spec.docs.audit.entries = [];
    spec.flush();
    expect(() => writeLegacyMigrationSourceSnapshot(mission, options)).toThrow(
      /does not pass its audit/u
    );
  });

  it('blocks open human decisions, undispositioned essence specs and a strategy without alternatives', () => {
    const { mission, docs, flush, options } = migrationFixture();
    docs.decisions.dispositions = [];
    docs.decisions.strategy = {
      selected: 'strangler_fig',
      alternatives: ['strangler_fig'],
      rationale: 'x',
    };
    flush();
    const run = () => validateLegacyMigrationEvidenceAt(mission, 'decisions', options);
    expect(run).toThrow(/essence-layer specs without a disposition/u);
    expect(run).toThrow(/rejected alternative/u);
    docs.decisions.dispositions = [
      { spec_id: 'SPEC-BEHAVIOR-ordering-01', disposition: 'human_decision' },
    ];
    docs.decisions.strategy = {
      selected: 'parallel_run',
      alternatives: ['big_bang'],
      rationale: 'x',
    };
    flush();
    expect(run).toThrow(/open human decision/u);
  });

  it('requires a parity scenario for every migrated spec', () => {
    const { mission, docs, flush, options } = migrationFixture();
    docs.pin.scenarios = [];
    flush();
    expect(() => validateLegacyMigrationEvidenceAt(mission, 'pin', options)).toThrow(
      /migrate specs without a parity scenario/u
    );
  });

  it('requires an approved deviation for every non-passing scenario', () => {
    const { mission, docs, flush, options } = migrationFixture();
    docs.equivalence.results = [
      { scenario_id: 'PAR-001', target_result: 'deviation', deviation: { reason: 'tax rounding' } },
    ];
    flush();
    expect(() => validateLegacyMigrationEvidenceAt(mission, 'equivalence', options)).toThrow(
      /approved_by/u
    );
    docs.equivalence.results = [
      { scenario_id: 'PAR-001', target_result: 'pass' },
      { scenario_id: 'PAR-001', target_result: 'pass' },
    ];
    flush();
    expect(() => validateLegacyMigrationEvidenceAt(mission, 'equivalence', options)).toThrow(
      /more than one result/u
    );
    (docs.pin.scenarios as Record<string, unknown>[])[0].legacy_result = 'fail_recorded';
    docs.equivalence.results = [{ scenario_id: 'PAR-001', target_result: 'pass' }];
    flush();
    expect(() => validateLegacyMigrationEvidenceAt(mission, 'equivalence', options)).toThrow(
      /approved_by/u
    );
    docs.equivalence.results = [];
    flush();
    expect(() => validateLegacyMigrationEvidenceAt(mission, 'equivalence', options)).toThrow(
      /without a target result: PAR-001/u
    );
  });
});
