import { describe, expect, it } from 'vitest';
import { pathResolver, safeReaddir, safeReadFile } from '@agent/core';

/**
 * OW-05: actuator ops that are registered must be reachable from a runnable
 * pipeline (or another caller). These ops were registered but never called;
 * each now has a minimal example pipeline under pipelines/.
 */
const EXAMPLE_PIPELINE_OPS: Record<string, string> = {
  'browser:action_trail': 'browser-failure-evidence',
  'browser:export_failure_bundle': 'browser-failure-evidence',
  'meeting:hearing_session': 'meeting-hearing-session',
  'meeting:tutor_session': 'meeting-tutor-session',
  'system:list_incidents': 'incident-review',
  'system:sre_analyze': 'incident-review',
  'agent:staff_mission': 'mission-team-staff',
  'agent:prewarm_mission': 'mission-team-prewarm',
  'modeling:terraform_to_topology_ir': 'terraform-topology-ir',
  'modeling:test_inventory_to_device_pipeline': 'test-inventory-device-pipeline',
};

function collectOps(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectOps(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'op' && typeof value === 'string') out.add(value);
      else collectOps(value, out);
    }
  }
}

function loadPipeline(id: string): { pipeline_id?: string; steps?: unknown[] } {
  const file = pathResolver.rootResolve(`pipelines/${id}.json`);
  return JSON.parse(String(safeReadFile(file, { encoding: 'utf8' })));
}

describe('orphan actuator op reachability (OW-05)', () => {
  it('ships a pipeline file for every formerly-unreachable op', () => {
    const files = new Set(safeReaddir(pathResolver.rootResolve('pipelines')));
    for (const id of new Set(Object.values(EXAMPLE_PIPELINE_OPS))) {
      expect(files.has(`${id}.json`), `pipelines/${id}.json`).toBe(true);
    }
  });

  it.each(Object.entries(EXAMPLE_PIPELINE_OPS))('%s is called by pipelines/%s.json', (op, id) => {
    const pipeline = loadPipeline(id);
    expect(pipeline.pipeline_id).toBe(id);
    const ops = new Set<string>();
    collectOps(pipeline.steps, ops);
    expect(ops.has(op)).toBe(true);
  });
});
