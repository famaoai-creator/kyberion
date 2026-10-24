import { describe, expect, it } from 'vitest';
import {
  defaultHearingScenario,
  findHearingScenario,
  hearingPhaseProgress,
  hearingRequirementPhases,
  loadHearingScenarios,
  type HearingScenarioCatalogEntry,
} from './hearing-scenario-catalog.js';

describe('hearing scenario catalog', () => {
  it('loads the web_app_build, work_inventory, process_improvement and aidlc_inception scenarios through the governed catalog', () => {
    const catalog = loadHearingScenarios();
    expect(catalog.scenarios.map((scenario) => scenario.id)).toEqual([
      'web_app_build',
      'work_inventory',
      'process_improvement',
      'aidlc_inception',
    ]);
    expect(defaultHearingScenario().id).toBe('web_app_build');
  });

  it('keeps every phase-structured sheet complete: each requirement in exactly one phase, all labels vocabulary keys', () => {
    for (const scenario of loadHearingScenarios().scenarios) {
      if (!scenario.phases) continue;
      const phaseOf = hearingRequirementPhases(scenario);
      expect([...phaseOf.keys()].sort()).toEqual(scenario.requirements.map((r) => r.id).sort());
      for (const phase of scenario.phases) expect(phase.title_key).toMatch(/^front_desk:/u);
    }
    expect(
      findHearingScenario('web_app_build')?.phases?.map((p) => [p.id, p.requirement_ids.length])
    ).toEqual([
      ['purpose', 2],
      ['shape', 3],
      ['limits', 2],
    ]);
    expect(
      findHearingScenario('aidlc_inception')?.phases?.map((p) => [p.id, p.requirement_ids.length])
    ).toEqual([
      ['intent', 3],
      ['elaboration', 2],
      ['nfr', 4],
      ['units', 2],
      ['constraints', 2],
    ]);
  });

  it('refuses a phase that names an unknown requirement or doubles one', () => {
    const base: HearingScenarioCatalogEntry = {
      id: 's',
      label_key: 'front_desk:x',
      description_key: 'front_desk:x',
      requirements: [{ id: 'a', label_key: 'front_desk:a' }],
      canvas: 'web_app_preview',
      handoff: 'mission',
    };
    expect(() =>
      hearingRequirementPhases({
        ...base,
        phases: [{ id: 'p', title_key: 'front_desk:p', requirement_ids: ['b'] }],
      })
    ).toThrow(/unknown requirement b/u);
    expect(() =>
      hearingRequirementPhases({
        ...base,
        phases: [
          { id: 'p', title_key: 'front_desk:p', requirement_ids: ['a'] },
          { id: 'q', title_key: 'front_desk:q', requirement_ids: ['a'] },
        ],
      })
    ).toThrow(/two phases/u);
  });

  it('reports per-phase progress and the current phase, and tolerates records without phases', () => {
    const scenario = findHearingScenario('web_app_build')!;
    const phaseOf = hearingRequirementPhases(scenario);
    const answered = new Set(['audience', 'problem', 'core_flow']);
    const requirements = scenario.requirements.map((r) => ({
      id: r.id,
      phase_id: phaseOf.get(r.id),
      ...(answered.has(r.id) ? { answer: 'x' } : {}),
    }));
    const progress = hearingPhaseProgress(requirements, scenario.phases ?? []);
    expect(progress.phases.map((p) => [p.id, p.complete, p.total, p.index])).toEqual([
      ['purpose', 2, 2, 1],
      ['shape', 1, 3, 2],
      ['limits', 0, 2, 3],
    ]);
    expect(progress.current?.id).toBe('shape');
    const done = hearingPhaseProgress(
      requirements.map((r) => ({ ...r, answer: 'x' })),
      scenario.phases ?? []
    );
    expect(done.current).toBeNull();
    const legacy = hearingPhaseProgress([{ id: 'a', answer: 'x' }, { id: 'b' }], []);
    expect(legacy.phases).toHaveLength(1);
    expect(legacy.current?.total).toBe(2);
  });

  it('keeps the web_app_build requirement ids/labels the same as the previous hardcoded scenario', () => {
    const scenario = findHearingScenario('web_app_build');
    expect(scenario?.canvas).toBe('web_app_preview');
    expect(scenario?.handoff).toBe('mission');
    expect(scenario?.requirements.map((item) => item.id)).toEqual([
      'audience',
      'problem',
      'core_flow',
      'content',
      'visual_direction',
      'constraints',
      'success',
    ]);
    expect(scenario?.requirements.map((item) => item.label_key)).toEqual([
      'front_desk:hearing_req_audience',
      'front_desk:hearing_req_problem',
      'front_desk:hearing_req_core_flow',
      'front_desk:hearing_req_content',
      'front_desk:hearing_req_visual_direction',
      'front_desk:hearing_req_constraints',
      'front_desk:hearing_req_success',
    ]);
  });

  it('defines the work_inventory scenario with the eight requirements and its own canvas/handoff', () => {
    const scenario = findHearingScenario('work_inventory');
    expect(scenario?.canvas).toBe('work_inventory_table');
    expect(scenario?.handoff).toBe('work_inventory');
    expect(scenario?.requirements.map((item) => item.id)).toEqual([
      'task_name',
      'trigger',
      'frequency',
      'effort',
      'steps',
      'systems',
      'decisions',
      'output',
    ]);
    for (const requirement of scenario?.requirements ?? []) {
      expect(requirement.label_key).toMatch(/^front_desk:hearing_req_/);
    }
  });

  it('returns undefined for an unknown scenario id', () => {
    expect(findHearingScenario('does-not-exist')).toBeUndefined();
  });
});
