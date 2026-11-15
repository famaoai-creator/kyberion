import { describe, expect, it } from 'vitest';
import { pathResolver, safeReaddir, safeReadFile } from '@agent/core';

/**
 * OW-05: actuator ops that are registered must be reachable from a runnable
 * pipeline (or another caller). These ops were registered but never called;
 * each now has a minimal example pipeline under pipelines/ or a user-facing
 * template under knowledge/product/pipeline-templates/.
 */
const EXAMPLE_PIPELINE_OPS: Record<string, string> = {
  'wisdom:document_review': 'pipelines/document-review.json',
  'vcs:development_loop': 'pipelines/vcs-development-preflight.json',
  'system:list_shortcuts': 'pipelines/apple-shortcuts-readiness.json',
  'system:run_shortcut': 'pipelines/apple-shortcut-approved-run.json',
  'system:apple_capabilities': 'pipelines/apple-native-capabilities.json',
  'system:ask_screen': 'pipelines/apple-screen-question.json',
  'browser:action_trail': 'pipelines/browser-failure-evidence.json',
  'browser:export_failure_bundle': 'pipelines/browser-failure-evidence.json',
  'browser:session_health': 'pipelines/browser-failure-evidence.json',
  'meeting:hearing_session': 'knowledge/product/pipeline-templates/meeting-hearing-session.json',
  'meeting:tutor_session': 'knowledge/product/pipeline-templates/meeting-tutor-session.json',
  'system:list_incidents': 'pipelines/incident-review.json',
  'system:sre_analyze': 'pipelines/incident-review.json',
  'agent:staff_mission': 'pipelines/mission-team-staff.json',
  'agent:prewarm_mission': 'pipelines/mission-team-prewarm.json',
  'modeling:terraform_to_topology_ir': 'pipelines/terraform-topology-ir.json',
  'modeling:terraform_asset_inventory': 'pipelines/terraform-asset-inventory.json',
  'modeling:asset_inventory_to_ledger': 'pipelines/external-asset-ledger.json',
  'modeling:security_ledger_check_plan': 'pipelines/exposure-check.json',
  'network:exposure_check': 'pipelines/exposure-check.json',
  'modeling:test_inventory_to_device_pipeline': 'pipelines/test-inventory-device-pipeline.json',
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

function loadPipeline(relative: string): { pipeline_id?: string; steps?: unknown[] } {
  const file = pathResolver.rootResolve(relative);
  return JSON.parse(String(safeReadFile(file, { encoding: 'utf8' })));
}

describe('orphan actuator op reachability (OW-05)', () => {
  it('ships a pipeline file for every formerly-unreachable op', () => {
    const dirCache = new Map<string, Set<string>>();
    for (const relative of new Set(Object.values(EXAMPLE_PIPELINE_OPS))) {
      const dir = relative.split('/').slice(0, -1).join('/');
      const base = relative.split('/').pop() as string;
      if (!dirCache.has(dir)) {
        dirCache.set(dir, new Set(safeReaddir(pathResolver.rootResolve(dir))));
      }
      expect(dirCache.get(dir)?.has(base), relative).toBe(true);
    }
  });

  it.each(Object.entries(EXAMPLE_PIPELINE_OPS))('%s is called by %s', (op, relative) => {
    const pipeline = loadPipeline(relative);
    const name = (relative.split('/').pop() as string).replace(/\.json$/, '');
    expect(pipeline.pipeline_id).toBe(name);
    const ops = new Set<string>();
    collectOps(pipeline.steps, ops);
    expect(ops.has(op)).toBe(true);
  });
});
