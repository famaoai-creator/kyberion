import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  analyzeSourceTree,
  buildAgenticSourceReviewParticipants,
  compileAgenticSourceReviewVerification,
  compileAgenticSourceReviewPlan,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  validateAgenticSourceReviewPlan,
} from './index.js';

const ROOT = path.resolve(process.cwd());
const FIXTURE = path.join(ROOT, 'active/shared/tmp/agentic-source-review-tests/sample-app');

function prepareFixture(): void {
  safeRmSync(FIXTURE, { recursive: true, force: true });
  safeMkdir(path.join(FIXTURE, 'src'), { recursive: true });
  safeMkdir(path.join(FIXTURE, 'docs'), { recursive: true });
  safeWriteFile(
    path.join(FIXTURE, 'package.json'),
    JSON.stringify({ dependencies: { express: '^5.0.0' } })
  );
  safeWriteFile(
    path.join(FIXTURE, 'src/app.ts'),
    "import express from 'express';\nconst app = express();\napp.post('/users', (_req, res) => res.send('ok'));\nexport const appName = 'sample';\n"
  );
  safeWriteFile(path.join(FIXTURE, 'docs/architecture.md'), '# Architecture\n');
  safeWriteFile(
    path.join(FIXTURE, 'src/app.test.ts'),
    "import { it } from 'vitest'; it('works', () => {});\n"
  );
}

describe('agentic source review plan', () => {
  it('creates a threat-model-first plan and selects hierarchical rules', () => {
    prepareFixture();
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/agentic-source-review-tests/sample-app',
    });
    const plan = compileAgenticSourceReviewPlan({ analysis, projectId: 'sample-app' });

    expect(plan.threat_model.status).toBe('pending_human_approval');
    expect(plan.threat_model.approval_ref).toBeNull();
    expect(plan.threat_model.entry_points).toMatchObject([
      {
        id: 'ENTRY-001',
        method: 'POST',
        path: '/users',
        review_tracks: ['access_control', 'data_flow'],
      },
    ]);
    expect(plan.context_enrichment.documentation_refs).toContain(
      'active/shared/tmp/agentic-source-review-tests/sample-app/docs/architecture.md'
    );
    expect(plan.selected_rules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([
        'domain:web',
        'language:typescript',
        'framework:express',
        'vulnerability:access-control',
        'vulnerability:data-flow',
        'vulnerability:dependency-supply-chain',
      ])
    );
    expect(plan.stages.find((stage) => stage.id === 'hypothesis_generation')?.status).toBe(
      'blocked'
    );
    expect(plan.coverage).toMatchObject({
      entry_points_total: 1,
      entry_points_selected: 1,
      entry_points_uncovered: 0,
      follow_up_required: false,
    });
    expect(plan.coverage.source_snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.validation_policy.automatic_remediation).toBe(false);
    expect(plan.limitations.join('\n')).toContain('prompt injection');
    expect(() => validateAgenticSourceReviewPlan(plan)).not.toThrow();
  });

  it('requires an approval reference in addition to the approval flag', () => {
    prepareFixture();
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/agentic-source-review-tests/sample-app',
    });
    const notApproved = compileAgenticSourceReviewPlan({
      analysis,
      projectId: 'sample-app',
      threatModelApproved: true,
    });
    const approved = compileAgenticSourceReviewPlan({
      analysis,
      projectId: 'sample-app',
      threatModelApproved: true,
      approvalRef: 'review-123',
    });

    expect(notApproved.threat_model.status).toBe('pending_human_approval');
    expect(approved.threat_model).toMatchObject({ status: 'approved', approval_ref: 'review-123' });
    expect(approved.stages.find((stage) => stage.id === 'hypothesis_validation')?.status).toBe(
      'complete'
    );
  });

  it('treats exported library functions as candidate entry points', () => {
    prepareFixture();
    safeWriteFile(
      path.join(FIXTURE, 'src/app.ts'),
      'export function run(input: string) { return input; }\n'
    );
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/agentic-source-review-tests/sample-app',
    });
    const plan = compileAgenticSourceReviewPlan({ analysis, projectId: 'sample-app' });

    expect(plan.threat_model.entry_points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'EXPORT',
          path: 'module:src/app.ts#run',
        }),
      ])
    );
  });

  it('fails closed when a reasoning participant has no canonical scope', () => {
    expect(() => buildAgenticSourceReviewParticipants({ projectId: 'sample-app' })).toThrow(
      '[AGENTIC_SOURCE_REVIEW_SCOPE_REQUIRED]'
    );
    const participants = buildAgenticSourceReviewParticipants({
      tenantSlug: 'tenant-sample',
      projectId: 'sample-app',
      missionId: 'MSN-SAMPLE-20260823',
      externalEgress: 'deny',
      allowedReasoningBackends: ['ollama'],
    });
    expect(participants).toHaveLength(3);
    expect(participants[0].security_scope).toMatchObject({
      tenant_slug: 'tenant-sample',
      project_id: 'sample-app',
      mission_id: 'MSN-SAMPLE-20260823',
      external_egress: 'deny',
      allowed_reasoning_backends: ['ollama'],
    });
    expect(() =>
      buildAgenticSourceReviewParticipants({
        tenantSlug: 'tenant-sample',
        projectId: 'sample-app',
        missionId: 'MSN-SAMPLE-20260823',
        outputTier: 'public',
      })
    ).toThrow('[AGENTIC_SOURCE_REVIEW_PUBLIC_OUTPUT_DENIED]');
    expect(() =>
      buildAgenticSourceReviewParticipants({
        tenantSlug: 'tenant-sample',
        projectId: 'sample-app',
        missionId: 'MSN-SAMPLE-20260823',
        externalEgress: 'allow',
      })
    ).toThrow('[AGENTIC_SOURCE_REVIEW_EGRESS_APPROVAL_REQUIRED]');
    expect(
      buildAgenticSourceReviewParticipants({
        tenantSlug: 'tenant-sample',
        projectId: 'sample-app',
        missionId: 'MSN-SAMPLE-20260823',
        externalEgress: 'allow',
        externalEgressApproved: true,
      })[0].security_scope
    ).toMatchObject({ external_egress: 'allow' });
  });

  it('separates evidence readiness from vulnerability verification and deduplicates fail-closed', () => {
    prepareFixture();
    const analysis = analyzeSourceTree({
      sourceRoot: 'active/shared/tmp/agentic-source-review-tests/sample-app',
    });
    const plan = compileAgenticSourceReviewPlan({
      analysis,
      projectId: 'sample-app',
      threatModelApproved: true,
      approvalRef: 'review-123',
    });
    const candidate = {
      candidate_id: 'CAND-001',
      title: 'Missing authorization check',
      track: 'access_control',
      severity_hint: 'high',
      entry_point_id: 'ENTRY-001',
      source_refs: ['src/app.ts'],
      hypothesis: 'The route may accept an unauthenticated request.',
      evidence: ['Static signal at src/app.ts:3'],
    };
    const report = compileAgenticSourceReviewVerification({
      analysis,
      entryPoints: plan.threat_model.entry_points,
      candidates: { findings: [candidate, candidate, { title: 'malformed' }] },
      knownFindingFingerprints: [],
    });

    expect(report.summary).toMatchObject({
      total: 3,
      new_candidates: 1,
      duplicates: 1,
      needs_review: 1,
    });
    expect(report.findings[0]).toMatchObject({
      decision: 'new',
      verification_status: 'evidence_ready',
      checks: { executable_witness: false, source_refs_known: true },
    });
    expect(report.findings[1].decision).toBe('duplicate');
    expect(report.findings[2]).toMatchObject({
      decision: 'needs_review',
      verification_status: 'blocked',
    });
    expect(report.policy).toMatchObject({ execution: 'disabled', automatic_remediation: false });
    expect(report.reverification.regression_test_promotion).toMatchObject({
      status: 'approval_required',
      artifact_kind: 'source-test-scenarios',
      candidate_ids: ['CAND-001'],
    });

    const malformedPayload = compileAgenticSourceReviewVerification({
      analysis,
      entryPoints: plan.threat_model.entry_points,
      candidates: { unexpected: 'payload' },
    });
    expect(malformedPayload.summary).toMatchObject({ total: 1, needs_review: 1 });
    expect(malformedPayload.findings[0].reasons.join(' ')).toContain('candidate title is missing');
    expect(() =>
      compileAgenticSourceReviewVerification({
        analysis,
        entryPoints: plan.threat_model.entry_points,
        candidates: { findings: [candidate] },
        knownFindingFingerprints: ['existing-fingerprint'],
      })
    ).toThrow('[AGENTIC_SOURCE_REVIEW_DEDUP_SCOPE_REQUIRED]');
    expect(() =>
      compileAgenticSourceReviewVerification({
        analysis,
        entryPoints: plan.threat_model.entry_points,
        candidates: { findings: [candidate] },
        knownFindingFingerprints: ['existing-fingerprint'],
        scope: {
          tenant_slug: 'tenant-a',
          project_id: 'sample-app',
          mission_id: 'MSN-A',
        },
        knownFindingScope: {
          tenant_slug: 'tenant-b',
          project_id: 'sample-app',
          mission_id: 'MSN-A',
        },
      })
    ).toThrow('[AGENTIC_SOURCE_REVIEW_DEDUP_SCOPE_MISMATCH]');
  });
});
