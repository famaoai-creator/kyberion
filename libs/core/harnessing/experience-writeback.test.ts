import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeRmSync } from '../secure-io.js';
import { lookupLessons } from './experience-library.js';
import {
  buildExperienceRecord,
  experienceQualifies,
  persistExperience,
  type ExperienceSink,
} from './experience-writeback.js';
import type { RunOutcome } from './probe-runner.js';

const ROOT = path.join(process.cwd(), 'active/shared/tmp/harnessing-writeback-test');

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  label: 'win',
  run_dir: 'x',
  ok: true,
  delivered: true,
  exit_code: 0,
  wall_ms: 1,
  produced_files: [],
  staged_expected: [],
  error: '',
  recorded_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const record = {
  cue: 'probe tuning',
  lesson: "apply the 'win' overlay",
  evidence: 'report at runRoot/report.json',
  confidence: 'medium' as const,
};

const gate = (over: Partial<Parameters<typeof experienceQualifies>[0]> = {}) => ({
  decision: 'auto_advance',
  winner: 'win',
  winnerOutcome: outcome(),
  ...over,
});

describe('experienceQualifies gate', () => {
  it('accepts a qualifying auto_advance with a delivered winner', () => {
    expect(experienceQualifies(gate())).toBe(true);
  });
  it('rejects non-decisive decisions and a missing winner', () => {
    for (const decision of ['decline', 'human_gate', 'keep_base']) {
      expect(experienceQualifies(gate({ decision }))).toBe(false);
    }
    expect(experienceQualifies(gate({ winner: null }))).toBe(false);
  });
  it('rejects an outcome that never ran, never delivered, or was refused', () => {
    expect(experienceQualifies(gate({ winnerOutcome: outcome({ ok: false }) }))).toBe(false);
    expect(experienceQualifies(gate({ winnerOutcome: outcome({ delivered: false }) }))).toBe(false);
    expect(
      experienceQualifies(gate({ winnerOutcome: outcome({ probe_refused: 'leak_marker' }) }))
    ).toBe(false);
    expect(experienceQualifies(gate({ winnerOutcome: null }))).toBe(false);
  });
  it('rejects a materialization_error halt and a drifted base', () => {
    expect(experienceQualifies(gate({ halted_by: 'materialization_error' }))).toBe(false);
    expect(experienceQualifies(gate({ base_drifted: true }))).toBe(false);
  });
});

describe('persistExperience', () => {
  it('persists a qualifying record, then dedupes the identical cue+lesson', () => {
    const root = path.join(ROOT, 'lib-persist');
    safeRmSync(root);
    const sink: ExperienceSink = { root, domain: 'd1' };
    expect(persistExperience(sink, record, gate())).toBe('persisted');
    expect(persistExperience(sink, record, gate())).toBe('duplicate');
    expect(lookupLessons({ libraryRoot: root, domain: 'd1' })).toHaveLength(1);
  });
  it('rejects a non-qualifying record without touching the library', () => {
    const root = path.join(ROOT, 'lib-reject');
    safeRmSync(root);
    expect(
      persistExperience(
        { root, domain: 'd1' },
        record,
        gate({ decision: 'decline', winner: null, winnerOutcome: null })
      )
    ).toBe('rejected');
    expect(lookupLessons({ libraryRoot: root, domain: 'd1' })).toEqual([]);
  });
  it('respects the causal horizon — the write-back is invisible to an earlier asOf', () => {
    const root = path.join(ROOT, 'lib-causal');
    safeRmSync(root);
    persistExperience({ root, domain: 'd1' }, record, gate());
    expect(
      lookupLessons({ libraryRoot: root, domain: 'd1', asOf: '2020-01-01T00:00:00.000Z' })
    ).toEqual([]);
    expect(lookupLessons({ libraryRoot: root, domain: 'd1' })).toHaveLength(1);
  });
});

describe('buildExperienceRecord', () => {
  it('cites the report path and the adopted label honestly', () => {
    const e = buildExperienceRecord({
      scenarioDir: '/tmp/scen',
      base: outcome({ delivered: false }),
      winner: 'win',
      adoptedLabel: 'r2:win',
      reportPath: 'runRoot/report.json',
      materialized: true,
    });
    expect(e.evidence).toContain('runRoot/report.json');
    expect(e.evidence).toContain("adopted 'r2:win'");
    // Base did not deliver -> weaker evidence, medium confidence.
    expect(e.confidence).toBe('medium');
    const e2 = buildExperienceRecord({
      scenarioDir: '/tmp/scen',
      base: outcome({ delivered: true }),
      winner: 'win',
      adoptedLabel: 'win',
      reportPath: 'runRoot/report.json',
      materialized: false,
    });
    expect(e2.confidence).toBe('high');
    expect(e2.evidence).toContain('(decided, not materialized)');
  });
});
