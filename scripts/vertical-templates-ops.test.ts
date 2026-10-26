import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadActuatorOpRegistry } from '@agent/core/actuator/actuator-op-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { normalizePipelineOp } from './pipeline-execution-part-bootstrap.js';

// REQ-8 (MSN-UCDOC-ALIGN-20261026): every op used inside templates/verticals
// (and the fragments they include) must resolve to a real actuator op or a
// core control op. This blocks the drift class where templates reference
// aspirational ops like `for_each`, `extract`, or `wisdom:decide_approval`.

const ROOT = pathResolver.rootDir();

const TEMPLATE_FILES = [
  'templates/verticals/finance-ringi-approval/pipeline.json',
  'templates/verticals/it-saas-inventory/pipeline.json',
  'templates/verticals/lifestyle-reservation/pipeline.json',
];

// Fragments reachable from the vertical templates via core:include.
const FRAGMENT_FILES = [
  'pipelines/fragments/intra-login.json',
  'pipelines/fragments/ringi-approve-single.json',
  'pipelines/fragments/browser-session-start.json',
  'pipelines/fragments/browser-runtime-preflight.json',
  'knowledge/product/pipeline-templates/jira-update-watch.json',
];

// Engine-level control ops (adf-engine / DEFAULT_CONTROL_OPS + observed bare aliases).
const CORE_CONTROL_OPS = new Set([
  'if',
  'while',
  'loop_until',
  'retry_until_quality',
  'foreach',
  'parallel_foreach',
  'team_lead',
  'parallel_calls',
  'accumulate',
  'include',
  'judge_route',
  'await_decision',
  'await_state',
  'transform',
  'set',
  'log',
  'notify',
  'wait',
]);

// Browser-pipeline aliases that survive normalize (op-vocabulary).
const BROWSER_ALIASES = new Set([
  'navigate',
  'click_ref',
  'fill_ref',
  'select_ref',
  'submit_form',
  'press_ref',
  'wait_ref',
]);

function collectOps(steps: any[], acc: string[]): string[] {
  for (const step of steps || []) {
    if (step && typeof step.op === 'string') acc.push(step.op);
    const params = step?.params || {};
    for (const key of ['then', 'else', 'do', 'pipeline', 'steps', 'fallback']) {
      if (Array.isArray(params[key])) collectOps(params[key], acc);
    }
    if (step?.on_error && Array.isArray(step.on_error.fallback))
      collectOps(step.on_error.fallback, acc);
  }
  return acc;
}

function knownOps(): Set<string> {
  const reg = loadActuatorOpRegistry();
  const ops = new Set<string>();
  for (const key of ['shared_capture_ops', 'shared_transform_ops', 'shared_apply_ops'] as const) {
    for (const op of reg[key] || []) ops.add(op);
  }
  for (const [domain, dom] of Object.entries(reg.domains || {})) {
    for (const kind of ['capture', 'transform', 'apply', 'control'] as const) {
      for (const op of (dom as any)[kind] || []) {
        ops.add(`${domain}:${op}`);
        ops.add(op);
      }
    }
  }
  for (const op of CORE_CONTROL_OPS) {
    ops.add(op);
    ops.add(`core:${op}`);
  }
  for (const op of BROWSER_ALIASES) ops.add(`browser:${op}`);
  // Actuator entrypoint ops surfaced as step ops in shipped templates.
  ops.add('browser:pipeline');
  return ops;
}

function resolveQualified(op: string): string {
  const normalized = normalizePipelineOp(op);
  // core:include steps in these files use params.fragment — still resolves as core op.
  return normalized;
}

describe('vertical templates & included fragments use only resolvable ops', () => {
  const known = knownOps();

  for (const file of [...TEMPLATE_FILES, ...FRAGMENT_FILES]) {
    it(`${file} — all step ops resolve`, () => {
      const doc = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      const ops = collectOps(doc.steps || [], []);
      expect(ops.length).toBeGreaterThan(0);
      const unknown = ops.filter((op) => {
        const q = resolveQualified(op);
        return !known.has(q) && !known.has(q.split(':').slice(1).join(':')) && !known.has(op);
      });
      expect(unknown).toEqual([]);
    });
  }
});
