import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { handleAction } from './index.js';

const ROOT = pathResolver.rootDir();
const FIXTURE = 'active/shared/tmp/modeling-actuator-tests/source-engineering';

describe('modeling-actuator source engineering flow', () => {
  it('connects analyze, compile, and write typed operations', async () => {
    const fixtureRoot = path.join(ROOT, FIXTURE);
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    safeMkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    safeWriteFile(path.join(fixtureRoot, 'src/main.ts'), 'export const answer = 42;\n');
    safeWriteFile(
      path.join(fixtureRoot, 'src/main.test.ts'),
      "import { it } from 'vitest'; it('works', () => {});\n"
    );

    const result = await handleAction({
      action: 'pipeline',
      context: { project_id: 'modeling-fixture', target_provider: 'aws' },
      steps: [
        {
          type: 'transform',
          op: 'analyze_source_tree',
          params: { source_root: FIXTURE, export_as: 'source_analysis_ir' },
        },
        {
          type: 'transform',
          op: 'compile_engineering_artifacts',
          params: { from: 'source_analysis_ir', export_as: 'engineering_artifacts' },
        },
        {
          type: 'apply',
          op: 'write_engineering_artifacts',
          params: {
            from: 'engineering_artifacts',
            output_dir: `${FIXTURE}/output`,
            export_as: 'engineering_outputs',
          },
        },
      ],
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.source_analysis_ir.kind).toBe('source-analysis-ir');
    expect(result.context.engineering_outputs.analysis_ir).toBe(
      `${FIXTURE}/output/source-analysis-ir.json`
    );
  });

  it('connects the threat-model-first agentic source review operations', async () => {
    const fixtureRoot = path.join(ROOT, `${FIXTURE}-agentic`);
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    safeMkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    safeWriteFile(
      path.join(fixtureRoot, 'src/app.ts'),
      "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.send('ok'));\n"
    );

    const result = await handleAction({
      action: 'pipeline',
      context: { project_id: 'agentic-fixture' },
      steps: [
        {
          type: 'transform',
          op: 'analyze_source_tree',
          params: { source_root: `${FIXTURE}-agentic`, export_as: 'source_analysis_ir' },
        },
        {
          type: 'transform',
          op: 'compile_agentic_source_review_plan',
          params: { from: 'source_analysis_ir', export_as: 'review_plan' },
        },
        {
          type: 'apply',
          op: 'write_agentic_source_review_plan',
          params: {
            from: 'review_plan',
            output_dir: `${FIXTURE}-agentic/output`,
            export_as: 'review_output',
          },
        },
      ],
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.review_plan.kind).toBe('agentic-source-review-plan');
    expect(result.context.review_plan.threat_model.status).toBe('pending_human_approval');
    expect(result.context.review_output).toBe(
      `${FIXTURE}-agentic/output/agentic-source-review-plan.json`
    );
  });

  it('rejects approved review output outside the current mission', async () => {
    const fixtureRoot = path.join(ROOT, `${FIXTURE}-approved-scope`);
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    safeMkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    safeWriteFile(
      path.join(fixtureRoot, 'src/app.ts'),
      'export function run(input: string) { return input; }\n'
    );

    const rejected = await handleAction({
      action: 'pipeline',
      context: {
        project_id: 'agentic-fixture',
        tenant_slug: 'tenant-sample',
        mission_id: 'MSN-AGENTIC-SCOPE',
        threat_model_approved: true,
        approval_ref: 'human-review-1',
      },
      steps: [
        {
          type: 'transform',
          op: 'analyze_source_tree',
          params: { source_root: `${FIXTURE}-approved-scope`, export_as: 'source_analysis_ir' },
        },
        {
          type: 'transform',
          op: 'compile_agentic_source_review_plan',
          params: { from: 'source_analysis_ir', export_as: 'review_plan' },
        },
        {
          type: 'apply',
          op: 'write_agentic_source_review_plan',
          params: {
            from: 'review_plan',
            output_dir: `${FIXTURE}-approved-scope/output`,
          },
        },
      ],
    });
    expect(rejected.status).toBe('failed');
    expect(rejected.results.at(-1)?.error).toContain(
      '[AGENTIC_SOURCE_REVIEW_MISSION_OUTPUT_REQUIRED]'
    );
  });

  it('rejects an approved artifact path that only resembles the canonical mission path', async () => {
    const fixtureRoot = path.join(ROOT, `${FIXTURE}-approved-canonical`);
    const missionId = 'MSN-AGENTIC-CANONICAL';
    const tenantSlug = 'tenant-sample';
    const evidenceDir = path.join(
      pathResolver.missionDir(missionId, 'confidential', tenantSlug) + '-other',
      'evidence'
    );
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    safeMkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    safeWriteFile(path.join(fixtureRoot, 'src/app.ts'), 'export function run() { return 1; }\n');

    const result = await handleAction({
      action: 'pipeline',
      context: {
        project_id: 'agentic-fixture',
        tenant_slug: tenantSlug,
        mission_id: missionId,
        threat_model_approved: true,
        approval_ref: 'human-review-canonical',
      },
      steps: [
        {
          type: 'transform',
          op: 'analyze_source_tree',
          params: { source_root: `${FIXTURE}-approved-canonical`, export_as: 'source_analysis_ir' },
        },
        {
          type: 'transform',
          op: 'compile_agentic_source_review_plan',
          params: { from: 'source_analysis_ir', export_as: 'review_plan' },
        },
        {
          type: 'apply',
          op: 'write_agentic_source_review_plan',
          params: { from: 'review_plan', output_dir: evidenceDir, export_as: 'review_output' },
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.results.at(-1)?.error).toContain(
      '[AGENTIC_SOURCE_REVIEW_MISSION_OUTPUT_REQUIRED]'
    );
  });

  it('connects verification and writes a fail-closed evidence report', async () => {
    const fixtureRoot = path.join(ROOT, `${FIXTURE}-verification`);
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    safeMkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    safeWriteFile(
      path.join(fixtureRoot, 'src/app.ts'),
      'export function run(input: string) { return input; }\n'
    );

    const result = await handleAction({
      action: 'pipeline',
      context: {
        project_id: 'agentic-verification-fixture',
        review_hypotheses_verified_data: {
          findings: [
            {
              candidate_id: 'CAND-001',
              title: 'Unvalidated input',
              track: 'data_flow',
              severity_hint: 'medium',
              entry_point_id: 'ENTRY-001',
              source_refs: ['src/app.ts'],
              hypothesis: 'Input reaches the exported function without validation.',
              evidence: ['Static source reference src/app.ts'],
            },
          ],
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'analyze_source_tree',
          params: { source_root: `${FIXTURE}-verification`, export_as: 'source_analysis_ir' },
        },
        {
          type: 'transform',
          op: 'compile_agentic_source_review_plan',
          params: { from: 'source_analysis_ir', export_as: 'review_plan' },
        },
        {
          type: 'transform',
          op: 'compile_agentic_source_review_verification',
          params: {
            analysis_from: 'source_analysis_ir',
            plan_from: 'review_plan',
            candidates_from: 'review_hypotheses_verified_data',
            export_as: 'verification_report',
          },
        },
        {
          type: 'apply',
          op: 'write_agentic_source_review_verification',
          params: {
            from: 'verification_report',
            output_dir: `${FIXTURE}-verification/output`,
            export_as: 'verification_output',
          },
        },
      ],
    });

    expect(result.status).toBe('succeeded');
    expect(result.context.verification_report.summary.new_candidates).toBe(1);
    expect(result.context.verification_report.policy.execution).toBe('disabled');
    expect(result.context.verification_output).toBe(
      `${FIXTURE}-verification/output/agentic-source-review-verification.json`
    );
  });

  it('validates the review plan before compiling verification coverage', async () => {
    const fixtureRoot = path.join(ROOT, `${FIXTURE}-invalid-plan`);
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    safeMkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    safeWriteFile(path.join(fixtureRoot, 'src/app.ts'), 'export function run() { return 1; }\n');

    const result = await handleAction({
      action: 'pipeline',
      context: { project_id: 'agentic-invalid-plan' },
      steps: [
        {
          type: 'transform',
          op: 'analyze_source_tree',
          params: { source_root: `${FIXTURE}-invalid-plan`, export_as: 'source_analysis_ir' },
        },
        {
          type: 'transform',
          op: 'compile_agentic_source_review_plan',
          params: { from: 'source_analysis_ir', export_as: 'review_plan' },
        },
        {
          type: 'transform',
          op: 'compile_agentic_source_review_verification',
          params: {
            plan_from: 'review_plan',
            export_as: 'verification_report',
          },
        },
      ],
    });
    expect(result.status).toBe('succeeded');

    result.context.review_plan.threat_model.entry_points = undefined;
    const rejected = await handleAction({
      action: 'pipeline',
      context: result.context,
      steps: [
        {
          type: 'transform',
          op: 'compile_agentic_source_review_verification',
          params: {
            plan_from: 'review_plan',
            export_as: 'verification_report',
          },
        },
      ],
    });
    expect(rejected.status).toBe('failed');
    expect(rejected.results.at(-1)?.error).toContain('[AGENTIC_SOURCE_REVIEW_SCHEMA]');
  });
});
