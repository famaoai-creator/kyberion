import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopeContext } from '@agent/core/scope-context';
import * as path from 'node:path';
import { safeRmSync } from '@agent/core/secure-io';

const mocks = vi.hoisted(() => ({
  scope: { tier: 'public' } as ScopeContext,
  conversation: vi.fn(),
  materialize: vi.fn(),
}));
vi.mock('@agent/core/scope-context', async (original) => ({
  ...(await original<object>()),
  currentScope: () => mocks.scope,
}));
vi.mock('@agent/core/surface/surface-runtime-orchestrator', () => ({
  runSurfaceMessageConversation: mocks.conversation,
}));
vi.mock('@agent/core/execution-feedback', async (original) => ({
  ...(await original<object>()),
  materializeExecutionFeedbackCandidate: mocks.materialize,
}));
import { main } from './kyberion_home.js';

const organizationScope: ScopeContext = {
  tier: 'confidential',
  tenant_slug: 'synthetic-ask',
  organization_id: 'org-a',
  project_id: 'project-a',
  mission_id: 'MSN-SYNTHETIC-ASK',
  task_id: 'task-a',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  mocks.scope = { tier: 'public' };
  mocks.materialize.mockReturnValue({ candidate: null });
  mocks.conversation.mockResolvedValue({ text: 'Recorded.', executionFeedbackRecord: undefined });
});
afterEach(() => vi.unstubAllEnvs());

describe('CLI ask scope and source correlation', () => {
  it('carries the selected complete scope without overriding its tier with the CLI default', async () => {
    mocks.scope = organizationScope;
    await main([
      'ask',
      'feedback use-case-synthetic: dissatisfied: Check the original brief.',
      '--correlation-id',
      'original-execution',
      '--json',
    ]);
    expect(mocks.conversation).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { ...organizationScope, scope_kind: 'task' },
        missionId: organizationScope.mission_id,
        correlationId: 'original-execution',
        threadTs: 'original-execution',
        executionFeedback: expect.objectContaining({
          scenario_id: 'use-case-synthetic',
          outcome: 'dissatisfied',
        }),
      })
    );
  });

  it.each(['en', 'ja'] as const)(
    'forwards the selected %s locale through the input helper',
    async (locale) => {
      mocks.scope = organizationScope;
      await main([
        'ask',
        'feedback use-case-synthetic: dissatisfied',
        '--locale',
        locale,
        '--json',
      ]);
      expect(mocks.conversation).toHaveBeenCalledWith(expect.objectContaining({ locale }));
    }
  );

  it('passes the returned scoped feedback record unchanged into candidate materialization', async () => {
    mocks.scope = organizationScope;
    const record = {
      feedback_id: 'synthetic',
      scope: organizationScope,
      correlation_id: 'source-1',
    };
    mocks.conversation.mockResolvedValue({ text: 'Recorded.', executionFeedbackRecord: record });
    await main(['ask', 'feedback use-case-synthetic: dissatisfied', '--json']);
    expect(mocks.materialize).toHaveBeenCalledWith({ feedback: record });
  });

  it('records scoped feedback and a review-only learning candidate through the real entrypoint', async () => {
    mocks.scope = organizationScope;
    const actualConversation = await vi.importActual<
      typeof import('@agent/core/surface/surface-runtime-orchestrator')
    >('@agent/core/surface/surface-runtime-orchestrator');
    const actualFeedback = await vi.importActual<typeof import('@agent/core/execution-feedback')>(
      '@agent/core/execution-feedback'
    );
    mocks.conversation.mockImplementation(actualConversation.runSurfaceMessageConversation);
    mocks.materialize.mockImplementation(actualFeedback.materializeExecutionFeedbackCandidate);
    const output: unknown[] = [];
    try {
      await main(
        [
          'ask',
          'feedback use-case-synthetic: dissatisfied: Check the original brief.',
          '--correlation-id',
          'original-execution',
          '--json',
        ],
        (value) => output.push(value)
      );
      const result = JSON.parse(String(output[0]));
      expect(result.executionFeedbackRecord).toMatchObject({
        scope: organizationScope,
        correlation_id: 'original-execution',
      });
      expect(result.improvement.candidate).toMatchObject({
        scope: organizationScope,
        status: 'proposed',
        evidence_refs: expect.arrayContaining(['correlation:original-execution']),
      });
      expect(
        actualFeedback.inspectExecutionFeedbackLearning(
          result.improvement.candidate.candidate_id,
          organizationScope
        ).blockers[0]
      ).toMatch(/^promotion_scope_not_preserved:/);
    } finally {
      safeRmSync(path.dirname(actualFeedback.resolveExecutionFeedbackPath(organizationScope)), {
        recursive: true,
        force: true,
      });
    }
  });

  it.each([
    ['--tier', 'confidential', '--tenant', 'another-tenant'],
    ['--tier=confidential'],
    ['--tenant=another-tenant'],
    ['--tenant-slug', 'another-tenant'],
    ['--tenantSlug=another-tenant'],
    ['--tenant-id', 'another-tenant'],
    ['--tenantId=another-tenant'],
    ['--organization-id', 'another-org'],
    ['--project-id', 'another-project'],
    ['--mission-id', 'MSN-ANOTHER'],
    ['--task-id', 'another-task'],
    ['--sessionId=another-session'],
    ['--scope', '{"tier":"confidential","tenant_slug":"another-tenant"}'],
  ])('never silently ignores explicit scope options: %j', async (...flags) => {
    for (const selected of [{ tier: 'public' as const }, organizationScope]) {
      mocks.scope = selected;
      await expect(
        main(['ask', 'feedback use-case-synthetic: dissatisfied', ...flags])
      ).rejects.toThrow(/SURFACE_CLI_SCOPE_FLAGS_UNSUPPORTED/);
    }
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it('does not mistake scope-looking text inside feedback for a CLI option', async () => {
    const text = 'feedback use-case-synthetic: dissatisfied: Use --tenant=acme only after review.';
    await main(['ask', text, '--json']);
    expect(mocks.conversation).toHaveBeenCalledWith(expect.objectContaining({ text }));
  });

  it('refuses scoped non-feedback before any legacy conversation or delegation can start', async () => {
    mocks.scope = organizationScope;
    await expect(main(['ask', 'Implement the next mission task.'])).rejects.toThrow(
      /SURFACE_CLI_SCOPE_UNSUPPORTED/
    );
    expect(mocks.conversation).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it('keeps legacy unscoped conversations available', async () => {
    await main(['ask', 'Hello', '--correlation-id', 'ordinary-turn']);
    expect(mocks.conversation).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello', correlationId: 'ordinary-turn' })
    );
    expect(mocks.conversation.mock.calls[0][0]).not.toHaveProperty('scope');
  });

  it('rejects incomplete selected organization scope instead of silently writing global feedback', async () => {
    mocks.scope = { tier: 'confidential', organization_id: 'org-a' };
    await expect(main(['ask', 'feedback use-case-synthetic: dissatisfied'])).rejects.toThrow(
      /SCOPE/
    );
    expect(mocks.conversation).not.toHaveBeenCalled();
  });
});
