import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  findChangedSinceVerified,
  formatKnowledgeVerificationLabel,
  knowledgeVerificationLedgerPath,
  recordKnowledgeProblem,
  recordKnowledgeVerifiedRun,
  resolveKnowledgeVerification,
} from './knowledge-verification.js';

const root = pathResolver.sharedTmp(`knowledge-verification-test-${process.pid}`);
const feedbackDir = pathResolver.sharedTmp(`knowledge-verification-feedback-${process.pid}`);
const RUNBOOK = 'knowledge/confidential/tenant-a/runbooks/deploy.md';
const tenantA = { tier: 'confidential' as const, tenant_slug: 'tenant-a' };
const tenantB = { tier: 'confidential' as const, tenant_slug: 'tenant-b' };

function writeDoc(rel: string, body: string) {
  const abs = path.join(root, rel);
  safeMkdir(path.dirname(abs), { recursive: true });
  safeWriteFile(abs, body);
}

let savedFeedbackDir: string | undefined;
beforeEach(() => {
  savedFeedbackDir = process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR;
  process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = feedbackDir;
  writeDoc(RUNBOOK, '# Deploy\n\n1. build\n2. ship\n');
});

afterEach(() => {
  if (savedFeedbackDir === undefined) delete process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR;
  else process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = savedFeedbackDir;
  safeRmSync(root, { recursive: true, force: true });
  safeRmSync(feedbackDir, { recursive: true, force: true });
});

const stateOf = (scope = tenantA) =>
  resolveKnowledgeVerification([RUNBOOK], scope, root).get(RUNBOOK);

describe('knowledge verification ledger', () => {
  it('has no state for a document that never ran', () => {
    expect(stateOf()).toBeUndefined();
  });

  it('marks the current text verified after a successful run', () => {
    recordKnowledgeVerifiedRun({
      documentPaths: [RUNBOOK],
      scope: tenantA,
      at: '2026-10-01T00:00:00Z',
      rootDir: root,
    });
    expect(stateOf()).toEqual({ state: 'verified', last_success_at: '2026-10-01T00:00:00Z' });
  });

  it('flags a document whose text changed since it last worked, until it works again', () => {
    recordKnowledgeVerifiedRun({
      documentPaths: [RUNBOOK],
      scope: tenantA,
      at: '2026-10-01T00:00:00Z',
      rootDir: root,
    });
    writeDoc(RUNBOOK, '# Deploy\n\n1. build\n2. run migrations\n3. ship\n');
    expect(stateOf()?.state).toBe('changed_since_verified');

    recordKnowledgeVerifiedRun({
      documentPaths: [RUNBOOK],
      scope: tenantA,
      at: '2026-10-02T00:00:00Z',
      rootDir: root,
    });
    expect(stateOf()).toEqual({ state: 'verified', last_success_at: '2026-10-02T00:00:00Z' });
  });

  it('a wrong/stale report after the last success outranks it; a later success clears it', () => {
    recordKnowledgeVerifiedRun({
      documentPaths: [RUNBOOK],
      scope: tenantA,
      at: '2026-10-01T00:00:00Z',
      rootDir: root,
    });
    recordKnowledgeProblem({
      documentPath: RUNBOOK,
      kind: 'stale',
      scope: tenantA,
      at: '2026-10-03T00:00:00Z',
    });
    expect(stateOf()).toMatchObject({ state: 'reported_problem', last_problem_kind: 'stale' });

    recordKnowledgeVerifiedRun({
      documentPaths: [RUNBOOK],
      scope: tenantA,
      at: '2026-10-04T00:00:00Z',
      rootDir: root,
    });
    expect(stateOf()?.state).toBe('verified');
  });

  it('keeps tenants apart', () => {
    recordKnowledgeVerifiedRun({ documentPaths: [RUNBOOK], scope: tenantA, rootDir: root });
    expect(stateOf(tenantB)).toBeUndefined();
    expect(knowledgeVerificationLedgerPath(tenantA)).not.toBe(
      knowledgeVerificationLedgerPath(tenantB)
    );
    expect(knowledgeVerificationLedgerPath(tenantA)).toContain('/tenants/tenant-a/');
  });

  it('lists changed-since-verified documents only for the same project', () => {
    recordKnowledgeVerifiedRun({
      documentPaths: [RUNBOOK],
      scope: tenantA,
      projectId: 'PRJ-1',
      rootDir: root,
    });
    writeDoc(RUNBOOK, '# Deploy\n\nchanged\n');
    const forProject = (projectId?: string) =>
      findChangedSinceVerified({
        scope: tenantA,
        ...(projectId ? { projectId } : {}),
        limit: 3,
        rootDir: root,
      });
    expect(forProject('PRJ-1').map((e) => e.document_path)).toEqual([RUNBOOK]);
    expect(forProject('PRJ-2')).toEqual([]);
    expect(forProject()).toEqual([]);
  });

  it('ignores paths that escape the repository', () => {
    recordKnowledgeVerifiedRun({
      documentPaths: ['../etc/passwd', '/etc/passwd'],
      scope: tenantA,
      rootDir: root,
    });
    expect(resolveKnowledgeVerification(['../etc/passwd', '/etc/passwd'], tenantA, root).size).toBe(
      0
    );
  });

  it('renders a short label per state', () => {
    expect(formatKnowledgeVerificationLabel(undefined)).toBe('');
    expect(
      formatKnowledgeVerificationLabel({
        state: 'verified',
        last_success_at: '2026-10-01T00:00:00Z',
      })
    ).toContain('worked in a run on 2026-10-01');
    expect(
      formatKnowledgeVerificationLabel({
        state: 'changed_since_verified',
        last_success_at: '2026-10-01T00:00:00Z',
      })
    ).toContain('changed since it last worked');
    expect(
      formatKnowledgeVerificationLabel({
        state: 'reported_problem',
        last_problem_kind: 'wrong',
        last_problem_at: '2026-10-03T00:00:00Z',
      })
    ).toContain('reported wrong on 2026-10-03');
  });
});
