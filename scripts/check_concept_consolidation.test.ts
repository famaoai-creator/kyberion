import { describe, expect, it } from 'vitest';
import { countConcepts, conceptViolations, METRICS } from './check_concept_consolidation.js';

describe('concept consolidation regression budgets', () => {
  it('counts AST constructs without treating comments or payload strings as code', () => {
    const result = countConcepts(`
      // process.env.MISSION_ID; safeWriteFile(p, JSON.stringify(v))
      const text = "process.env.KYBERION_TENANT";
      const a = process.env.MISSION_ID;
      const b = process.env['KYBERION_TENANT'];
      getRegisteredEnvText('KYBERION_PERSONA');
      safeWriteFile(p, JSON.stringify(v));
      const p = 'active/shared/runtime/example.json';
      function fixedWindowLimiter() {}
      export type MissionStatus = 'active';
      argv.indexOf('--help');
    `);
    expect(result).toEqual({
      env_direct_read_budget: 3,
      json_state_write_budget: 1,
      runtime_path_literal_budget: 1,
      rate_limiter_impl_budget: 1,
      exported_type_name_duplication_budget: 1,
      bespoke_cli_parser_budget: 1,
    });
  });
  it('fails every metric independently, including new files; reductions cannot offset increases', () => {
    const zero = Object.fromEntries(METRICS.map((k) => [k, 0])) as ReturnType<typeof countConcepts>;
    const one = Object.fromEntries(METRICS.map((k) => [k, 1])) as ReturnType<typeof countConcepts>;
    const baseline = { version: 1 as const, files: { 'old.ts': one } };
    const current = { version: 1 as const, files: { 'new.ts': one, 'old.ts': zero } };
    expect(conceptViolations(current, baseline)).toHaveLength(6);
    for (const metric of METRICS)
      expect(conceptViolations(current, baseline, metric)).toHaveLength(1);
    expect(conceptViolations({ version: 1, files: { 'old.ts': zero } }, baseline)).toEqual([]);
  });
  it('tracks JSX, element env reads, nested stringify and ignores unrelated contracts', () => {
    const result = countConcepts(
      `const x=process.env['MISSION_ID']; safeWriteFile(p, wrap(JSON.stringify(v))); export type GateResult = {}; const ui=<div/>;`,
      'view.tsx'
    );
    expect(result.env_direct_read_budget).toBe(1);
    expect(result.json_state_write_budget).toBe(1);
    expect(result.exported_type_name_duplication_budget).toBe(0);
  });
  it('tracks destructured context env and scoped serialization aliases', () => {
    const result = countConcepts(
      `const {MISSION_ID: mission, KYBERION_TENANT} = process.env; const serialized = JSON.stringify(state); safeWriteFile(p, serialized); function unrelated(){const serialized = 'payload'; safeWriteFile(p,serialized);}`
    );
    expect(result.env_direct_read_budget).toBe(2);
    expect(result.json_state_write_budget).toBe(1);
  });
  it('rejects a new duplicated type name even when per-file totals stay equal', () => {
    const baseline = {
      version: 1 as const,
      files: {},
      exported_types: { GateResult: ['a.ts', 'b.ts', 'c.ts'] },
    };
    const current = {
      version: 1 as const,
      files: {},
      exported_types: { Replacement: ['a.ts', 'b.ts', 'c.ts'] },
    };
    expect(
      conceptViolations(current, baseline, 'exported_type_name_duplication_budget')
    ).toHaveLength(3);
  });
});
