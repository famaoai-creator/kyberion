import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { resetScopeEnvelopeState } from '../scope-envelope.js';
import {
  assessPipelineReadiness,
  formatPipelineReadinessReport,
  type PipelineReadinessDeps,
} from './pipeline-readiness.js';
import { deriveRunScope } from './run-scope.js';
import { ARGS_SUGGESTION_CAVEAT } from './run-manifest-args-suggest.js';

const ROOT = pathResolver.rootDir();
const FIXTURE_PARENT = path.join(ROOT, 'active', 'shared', 'tmp');
const TENANT = 'readiness-fixture';
const FLOW_PATH = `knowledge/confidential/${TENANT}/scenarios/run-approval-flow.json`;

/** The 2026-10 flow scenario shape (pipeline-run-manifest-model §1). */
const flow = {
  pipeline_id: 'run-approval-flow',
  steps: [
    {
      id: 'password',
      op: 'secret:get',
      params: { service: 'garoon', account: 'approver', export_as: 'pw' },
    },
    { id: 'open', op: 'browser:goto', params: { url: 'https://garoon.example.test/' } },
    { id: 'user', op: 'browser:fill', params: { selector: '#user', text: 'approver' } },
    { id: 'pass', op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
    { id: 'login', op: 'browser:click_first_match', params: { selectors: ['#login'] } },
    {
      id: 'poll',
      op: 'core:while',
      params: {
        condition: { from: 'pending', operator: 'eq', value: true },
        max_iterations: 5,
        pipeline: [
          { id: 'probe', op: 'browser:evaluate', params: { script: 'document.title' } },
          { id: 'pause', op: 'system:wait', params: { duration_ms: 500 } },
        ],
      },
    },
    { id: 'done', op: 'system:log', params: { message: 'approved' } },
  ],
};

describe('assessPipelineReadiness', () => {
  let fixtureRoot = '';
  let deps: PipelineReadinessDeps;
  let credentialProbes = 0;

  beforeEach(() => {
    resetScopeEnvelopeState();
    fixtureRoot = path.join(
      FIXTURE_PARENT,
      `pipeline-readiness-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    const dir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      path.join(dir, `${TENANT}.json`),
      JSON.stringify({
        tenant_slug: TENANT,
        display_name: 'Readiness fixture',
        status: 'active',
        assigned_role: 'owner',
      })
    );
    credentialProbes = 0;
    deps = {
      deriveScope: (inputPath) =>
        deriveRunScope(inputPath, {
          env: {},
          registry: { rootDir: fixtureRoot, env: {} as NodeJS.ProcessEnv },
        }),
      findTrustApproval: () => null,
      manifestRunUsage: () => ({ runs_today: 3, runs_per_day: 20 }),
      credentialReadiness: () => {
        credentialProbes += 1;
        return { status: 'binding_required', identity: { tenantSlug: TENANT } } as never;
      },
      resolvePrincipal: ({ hasHuman }) =>
        hasHuman === true
          ? { mode: 'attended', memberId: 'owner', reason: 'terminal + active member' }
          : { mode: 'unattended', reason: 'no terminal present' },
    };
  });

  afterEach(() => {
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = '';
  });

  const byId = (report: ReturnType<typeof assessPipelineReadiness>, id: string) =>
    report.checks.find((check) => check.id === id);

  it('answers every gate of the flow scenario before the run', () => {
    const report = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow, hasHuman: true },
      deps
    );
    expect(report.side_effects).toBe('none');
    expect(byId(report, 'scope')).toMatchObject({ status: 'pass' });
    expect(byId(report, 'scope')?.message).toContain(`tenant ${TENANT}`);
    expect(byId(report, 'model')).toMatchObject({
      status: 'pass',
      message: 'not needed (deterministic steps only)',
    });
    expect(credentialProbes).toBe(0);
    expect(byId(report, 'secrets')?.message).toContain('garoon/approver');
    expect(byId(report, 'secrets')?.message).not.toContain('{{pw}}');
    const effects = byId(report, 'effects');
    expect(effects?.status).toBe('warning');
    // goto, fill ×2, click_first_match and the loop-body evaluate need admission.
    expect(effects?.message).toMatch(/^5 step\(s\)/u);
    expect(byId(report, 'principal')).toMatchObject({
      status: 'pass',
      message:
        'attended (owner) — pre-approval applies only when this member approved the manifest',
    });
    expect(byId(report, 'trust')).toMatchObject({
      status: 'blocked',
      next: `pnpm kyberion project-trust request ${FLOW_PATH}, then pnpm kyberion approvals --approve <request-id>`,
    });
    expect(report.verdict).toBe('blocked');
    expect(report.next_actions[0]).toContain('pnpm kyberion project-trust request');
  });

  it('warns about declared browser options the run will not apply', () => {
    const profiles = `active/shared/runtime/browser/profiles/confidential/${TENANT}`;
    const clean = assessPipelineReadiness(
      {
        inputPath: FLOW_PATH,
        pipeline: { ...flow, options: { headless: false, record_trace: false } } as never,
        hasHuman: true,
      },
      deps
    );
    expect(byId(clean, 'browser')).toMatchObject({ status: 'pass' });
    const report = assessPipelineReadiness(
      {
        inputPath: FLOW_PATH,
        pipeline: {
          ...flow,
          options: {
            headless: false,
            user_data_dir: 'active/shared/runtime/browser/flow',
            launch_args: ['--proxy-server=x'],
          },
        } as never,
        hasHuman: true,
      },
      deps
    );
    const browser = byId(report, 'browser');
    expect(browser?.status).toBe('warning');
    expect(browser?.message).toMatch(/^2 declared option\(s\) will not be applied/u);
    expect(browser?.message).toContain('browser options.launch_args not applied');
    expect(browser?.message).toContain(`move the profile to ${profiles}/<profile-name>`);
    // No browser step: no browser row.
    const plain = assessPipelineReadiness(
      {
        inputPath: FLOW_PATH,
        pipeline: {
          steps: [{ op: 'system:log', params: {} }],
          options: { launch_args: ['x'] },
        } as never,
      },
      deps
    );
    expect(byId(plain, 'browser')).toBeUndefined();
  });

  it('passes trust with the run command when a valid approval exists', () => {
    const report = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow, hasHuman: true },
      { ...deps, findTrustApproval: () => 'APR-1' }
    );
    expect(byId(report, 'trust')).toMatchObject({
      status: 'pass',
      next: `pnpm pipeline --input ${FLOW_PATH} --project-trust-approval APR-1`,
    });
    expect(report.verdict).toBe('warning');
  });

  it('reports a scope mismatch as a blocked check with its next command', () => {
    const report = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow },
      {
        ...deps,
        deriveScope: (inputPath) =>
          deriveRunScope(inputPath, {
            env: { KYBERION_TENANT: 'someone-else' },
            registry: { rootDir: fixtureRoot, env: {} as NodeJS.ProcessEnv },
          }),
      }
    );
    expect(byId(report, 'scope')).toMatchObject({
      status: 'blocked',
      next: 'unset KYBERION_TENANT or move the pipeline',
    });
    expect(byId(report, 'scope')?.message).toMatch(/^\[RUN_SCOPE_MISMATCH\]/u);
    expect(byId(report, 'principal')?.status).toBe('warning');
  });

  it('reports model credential readiness without installing a provider', () => {
    const report = assessPipelineReadiness(
      {
        inputPath: FLOW_PATH,
        pipeline: {
          pipeline_id: 'needs-model',
          steps: [{ id: 'think', op: 'reasoning:analyze', params: {} }],
        },
        hasHuman: true,
      },
      deps
    );
    expect(credentialProbes).toBe(1);
    expect(byId(report, 'model')).toMatchObject({ status: 'blocked' });
    expect(byId(report, 'model')?.message).toContain('reasoning:analyze');
  });

  it('treats repository-owned pipelines as trusted and tenant-less', () => {
    const report = assessPipelineReadiness(
      {
        inputPath: 'pipelines/baseline-check.json',
        pipeline: { pipeline_id: 'b', steps: [{ id: 'log', op: 'system:log', params: {} }] },
        hasHuman: true,
      },
      deps
    );
    expect(byId(report, 'trust')).toMatchObject({ status: 'pass' });
    expect(byId(report, 'scope')?.message).toContain('ambient scope');
    expect(report.verdict).toBe('ready');
  });

  it('still answers scope and trust when the pipeline cannot be loaded', () => {
    const report = assessPipelineReadiness(
      { inputPath: FLOW_PATH, loadError: 'Invalid pipeline ADF guardrails: x' },
      deps
    );
    expect(report.checks.map((check) => check.id)).toEqual([
      'scope',
      'trust',
      'principal',
      'contract-validation',
    ]);
    expect(report.verdict).toBe('blocked');
  });

  const withManifest = { sourceText: JSON.stringify(flow), pipeline: flow };

  it('reports Run Manifest coverage of the external steps', () => {
    const report = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow, hasHuman: true, manifestSource: withManifest },
      deps
    );
    expect(byId(report, 'effects')).toMatchObject({
      status: 'pass',
      message: '5 external step(s), 5 pre-approvable',
    });
    const templated = {
      ...flow,
      steps: [...flow.steps, { id: 'next', op: 'browser:goto', params: { url: '{{next_url}}' } }],
    };
    const partial = assessPipelineReadiness(
      {
        inputPath: FLOW_PATH,
        pipeline: templated,
        manifestSource: { sourceText: JSON.stringify(templated), pipeline: templated },
      },
      deps
    );
    expect(byId(partial, 'effects')?.status).toBe('warning');
    expect(byId(partial, 'effects')?.message).toBe(
      '6 external step(s), 5 pre-approvable; per-step approval: 7 browser:goto (templated_host)'
    );
  });

  it('suggests the evaluate args rewrite for templated page scripts', () => {
    const scripted = {
      ...flow,
      steps: [
        ...flow.steps,
        {
          id: 'pick',
          op: 'browser:evaluate',
          params: { script: "(() => '{{target}}'.split(' | ')[0])()", export_as: 'first' },
        },
        {
          id: 'regex',
          op: 'browser:evaluate',
          params: { script: '(() => /{{pattern}}/.test(document.title))()' },
        },
      ],
    };
    const report = assessPipelineReadiness(
      {
        inputPath: FLOW_PATH,
        pipeline: scripted,
        manifestSource: { sourceText: JSON.stringify(scripted), pipeline: scripted },
      },
      deps
    );
    const effects = byId(report, 'effects');
    expect(effects?.message).toContain('7 browser:evaluate (templated_script)');
    expect(effects?.details).toEqual([
      `step 7: "script": "(a) => String(a.target).split(' | ')[0]", "args": {"target":"{{target}}"} — ${ARGS_SUGGESTION_CAVEAT}`,
      'step 8: no args suggestion — a template sits inside a regular expression',
    ]);
    const lines = formatPipelineReadinessReport(report);
    const at = lines.findIndex((line) => line.includes('step 7: "script"'));
    expect(at).toBeGreaterThan(lines.findIndex((line) => /^ ! effects/u.test(line)));
    expect(lines[at]).toMatch(/^ {15}step 7: /u);
    // No suggestion lines when no page script is templated.
    const plain = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow, hasHuman: true, manifestSource: withManifest },
      deps
    );
    expect(byId(plain, 'effects')?.details).toBeUndefined();
  });

  it('passes trust on a manifest approval and warns on a file-only one', () => {
    const findManifestApproval = vi.fn(() => 'APR-2');
    const v2 = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow, hasHuman: true, manifestSource: withManifest },
      { ...deps, findManifestApproval, findTrustApproval: () => 'APR-1' }
    );
    const hash = findManifestApproval.mock.calls[0][1] as string;
    expect(byId(v2, 'trust')).toMatchObject({
      status: 'pass',
      message: `approved (manifest ${hash.slice(0, 12)}; APR-2; 3/20 runs today)`,
      next: `pnpm pipeline --input ${FLOW_PATH} --project-trust-approval APR-2`,
    });
    const exhausted = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow, hasHuman: true, manifestSource: withManifest },
      {
        ...deps,
        findManifestApproval,
        manifestRunUsage: () => ({ runs_today: 20, runs_per_day: 20 }),
      }
    );
    expect(byId(exhausted, 'trust')).toMatchObject({
      status: 'warning',
      message: `approved (manifest ${hash.slice(0, 12)}; APR-2; 20/20 runs today) — daily run cap reached; further runs today (UTC) ask for every external step`,
      next: `run again after 00:00 UTC, or re-approve with a higher cap: pnpm kyberion project-trust request ${FLOW_PATH} --runs-per-day <N>`,
    });
    // Usage that cannot be read never blocks the check.
    const unreadable = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow, hasHuman: true, manifestSource: withManifest },
      {
        ...deps,
        findManifestApproval,
        manifestRunUsage: () => {
          throw new Error('ledger unreadable');
        },
      }
    );
    expect(byId(unreadable, 'trust')).toMatchObject({
      status: 'pass',
      message: `approved (manifest ${hash.slice(0, 12)}; APR-2)`,
    });
    const v1 = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow, hasHuman: true, manifestSource: withManifest },
      { ...deps, findManifestApproval: () => null, findTrustApproval: () => 'APR-1' }
    );
    expect(byId(v1, 'trust')).toMatchObject({
      status: 'warning',
      message: `approved without manifest (APR-1) — every external step will ask; re-request: pnpm kyberion project-trust request ${FLOW_PATH}`,
    });
    const none = assessPipelineReadiness(
      { inputPath: FLOW_PATH, pipeline: flow, hasHuman: true, manifestSource: withManifest },
      { ...deps, findManifestApproval: () => null }
    );
    expect(byId(none, 'trust')?.status).toBe('blocked');
  });

  it('formats a concise table with marks and next lines', () => {
    const lines = formatPipelineReadinessReport(
      assessPipelineReadiness({ inputPath: FLOW_PATH, pipeline: flow, hasHuman: true }, deps)
    );
    expect(lines[0]).toBe('[pipeline-check] blocked: run-approval-flow');
    expect(lines.some((line) => /^ ✓ scope\s+tenant readiness-fixture/u.test(line))).toBe(true);
    expect(lines.some((line) => /^ ✗ trust\s+not approved/u.test(line))).toBe(true);
    expect(lines.some((line) => /^\s+next: pnpm kyberion project-trust request/u.test(line))).toBe(
      true
    );
  });
});
