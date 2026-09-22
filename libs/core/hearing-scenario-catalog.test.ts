import { describe, expect, it } from 'vitest';
import { findHearingScenario, loadHearingScenarios } from './hearing-scenario-catalog.js';

describe('hearing scenario catalog', () => {
  it('loads the web_app_build and work_inventory scenarios through the governed catalog', () => {
    const catalog = loadHearingScenarios();
    expect(catalog.scenarios.map((scenario) => scenario.id)).toEqual([
      'web_app_build',
      'work_inventory',
    ]);
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
