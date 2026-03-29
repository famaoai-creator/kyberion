import { describe, expect, it } from 'vitest';
import { buildAnalysisIntentSupport } from './analysis-intent-support.js';
import { saveProjectRecord } from './project-registry.js';

describe('analysis-intent-support', () => {
  it('auto-fills incident basis and review target from project context', () => {
    const support = buildAnalysisIntentSupport({
      intentId: 'incident-informed-review',
      taskType: 'analysis',
      payload: {
        analysis_kind: 'incident_informed_review',
      },
      requirements: {
        missing: ['incident_basis', 'review_target'],
        collected: {},
      },
      projectContext: {
        project_id: 'PRJ-TEST',
        track_id: 'TRK-1',
      },
    });

    expect(support.requirements?.missing || []).toEqual([]);
    expect(support.payload?.incident_basis).toBe('incident_history');
    expect(support.payload?.review_target).toBe('track:TRK-1');
  });

  it('auto-fills remediation target scope from project context', () => {
    const support = buildAnalysisIntentSupport({
      intentId: 'cross-project-remediation',
      taskType: 'analysis',
      payload: {
        analysis_kind: 'cross_project_remediation',
        source_corpus: 'requirements',
      },
      requirements: {
        missing: ['source_corpus', 'target_scope'],
        collected: {},
      },
      projectContext: {
        project_id: 'PRJ-TEST',
        track_id: 'TRK-2',
      },
    });

    expect(support.requirements?.missing || []).toEqual([]);
    expect(support.payload?.target_scope).toBe('project:PRJ-TEST/track:TRK-2');
    expect(support.payload?.source_corpus).toBe('requirements');
  });

  it('infers review target from utterance and repository context', () => {
    saveProjectRecord({
      project_id: 'PRJ-REVIEW',
      name: 'Review Project',
      summary: 'For review target inference tests',
      status: 'active',
      tier: 'confidential',
      repositories: [
        {
          repo_id: 'REPO-REVIEW',
          kind: 'application',
          root_path: 'active/projects/review-project',
        },
      ],
    });

    const prSupport = buildAnalysisIntentSupport({
      intentId: 'incident-informed-review',
      taskType: 'analysis',
      utterance: 'PR #128 を過去のインシデント結果を踏まえてレビューして',
      requirements: {
        missing: ['review_target'],
        collected: {},
      },
      projectContext: {
        project_id: 'PRJ-REVIEW',
      },
    });
    expect(prSupport.payload?.review_target).toBe('pull_request:128');

    const artifactSupport = buildAnalysisIntentSupport({
      intentId: 'incident-informed-review',
      taskType: 'analysis',
      utterance: 'ART-TEST-123 を過去の障害を踏まえてレビューして',
      requirements: {
        missing: ['review_target'],
        collected: {},
      },
      projectContext: {
        project_id: 'PRJ-REVIEW',
      },
    });
    expect(artifactSupport.payload?.review_target).toBe('artifact:ART-TEST-123');

    const repoSupport = buildAnalysisIntentSupport({
      intentId: 'incident-informed-review',
      taskType: 'analysis',
      utterance: '過去のインシデント結果を踏まえてレビューして',
      requirements: {
        missing: ['review_target'],
        collected: {},
      },
      projectContext: {
        project_id: 'PRJ-REVIEW',
      },
    });
    expect(repoSupport.payload?.review_target).toBe('repository:REPO-REVIEW');
  });

  it('binds review targets to repository execution context', () => {
    saveProjectRecord({
      project_id: 'PRJ-BIND',
      name: 'Binding Project',
      summary: 'For execution target binding',
      status: 'active',
      tier: 'confidential',
      repositories: [
        {
          repo_id: 'REPO-BIND',
          kind: 'application',
          root_path: 'active/projects/binding-project',
        },
      ],
    });

    const prSupport = buildAnalysisIntentSupport({
      intentId: 'incident-informed-review',
      taskType: 'analysis',
      payload: {
        review_target: 'pull_request:128',
      },
      projectContext: {
        project_id: 'PRJ-BIND',
      },
    });
    expect(prSupport.payload?.review_execution_target).toMatchObject({
      target_kind: 'pull_request',
      repository_id: 'REPO-BIND',
      repository_root_path: 'active/projects/binding-project',
      pr_number: 128,
    });

    const fileSupport = buildAnalysisIntentSupport({
      intentId: 'incident-informed-review',
      taskType: 'analysis',
      payload: {
        review_target: 'file:src/routes/app.ts',
      },
      projectContext: {
        project_id: 'PRJ-BIND',
      },
    });
    expect(fileSupport.payload?.review_execution_target).toMatchObject({
      target_kind: 'file',
      repository_id: 'REPO-BIND',
      repository_root_path: 'active/projects/binding-project',
      target_path: 'src/routes/app.ts',
    });
  });

  it('orders suggested refs toward track and target scope', () => {
    const support = buildAnalysisIntentSupport({
      intentId: 'incident-informed-review',
      taskType: 'analysis',
      utterance: 'TRK-42 の incident review をして',
      payload: {
        review_target: 'track:TRK-42',
      },
      projectContext: {
        project_id: 'PRJ-42',
        track_id: 'TRK-42',
      },
    });

    expect(support.suggested_refs.length).toBeGreaterThan(0);
    const firstRef = support.suggested_refs[0] || '';
    expect(firstRef.includes('TRK-42') || firstRef.startsWith('knowledge/public/incidents/')).toBe(true);
  });
});
