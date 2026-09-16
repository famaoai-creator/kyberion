import { describe, expect, it, vi } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { decideApprovalRequest, loadApprovalRequest } from '@agent/core/approval-store';
import { readSafeJsonFile } from '../lib/json-input.js';
import { isLocalPadOriginAllowed } from '../lib/local-artifact-pad.js';
import {
  main,
  PERSONAL_WORKBENCH_DEFAULT_PORT,
  validatePersonalWorkbenchContentLength,
} from './server.js';
import {
  applyCalendarEvent,
  calendarProposalPath,
  executePersonalWorkbenchAction,
  matchCalendarReconciliationEvents,
  parseCalendarEventPayload,
  proposeCalendarEvent,
  PERSONAL_WORKBENCH_APPROVAL_CHANNEL,
  reconcileCalendarEvent,
} from './actions.js';

describe('personal workbench', () => {
  it('validates configuration in public dry-run mode', async () => {
    const result = await main(['--dry-run', '--tier', 'public'], { dryRun: true });
    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: PERSONAL_WORKBENCH_DEFAULT_PORT,
      listening: false,
    });
  });

  it('requires a tenant for personal operation', async () => {
    await expect(main(['--dry-run'], { dryRun: true })).rejects.toThrow(
      'requires server-side KYBERION_TENANT scope'
    );
  });

  it('bounds declared request size and keeps capture proposal-only', () => {
    expect(validatePersonalWorkbenchContentLength('10')).toBe(10);
    expect(() => validatePersonalWorkbenchContentLength('not-a-number')).toThrow();
    const source = readTextFile(pathResolver.rootResolve('scripts/personal-workbench/server.ts'));
    expect(source).toContain("option(args, '--tier') || 'personal'");
    expect(source).toContain("req.headers['x-pw-token']");
    expect(source).toContain('isLocalPadOriginAllowed');
    expect(source).toContain('requires_human_approval: true');
    expect(source).toContain('Capture stores proposals only');
    expect(source).toContain('承認して作成');
    expect(source).not.toContain('node:fs');
  });

  it('allows only localhost origins', () => {
    expect(isLocalPadOriginAllowed(undefined)).toBe(true);
    expect(isLocalPadOriginAllowed('http://127.0.0.1:8154')).toBe(true);
    expect(isLocalPadOriginAllowed('https://evil.example')).toBe(false);
  });

  it('parses calendar payloads and requires confirmation before apply', async () => {
    expect(
      parseCalendarEventPayload({
        summary: '定例',
        start: '2026-09-14T10:00:00+09:00',
        end: '2026-09-14T10:30:00+09:00',
      })
    ).toMatchObject({ summary: '定例' });

    const context = {
      session_id: 'pwb-test',
      artifact_ref: 'active/shared/tmp/personal-workbench',
      viewer_principal: 'personal-test',
      scope: { scope_kind: 'tenant' as const, tier: 'personal' as const, tenant_slug: 'default' },
    };
    const outDir = pathResolver.sharedTmp('personal-workbench-test-calendar');
    const proposed = proposeCalendarEvent({
      payload: {
        summary: 'レビュー定例',
        start: '2026-09-14T10:00:00+09:00',
        end: '2026-09-14T10:30:00+09:00',
        description: 'workbench flow',
      },
      context,
      outDir,
      evidenceRef: `${outDir}/handoff.json`,
    });
    expect(proposed).toMatchObject({
      stage: 'propose',
      status: 'pending',
    });
    const event = {
      summary: 'レビュー定例',
      start: '2026-09-14T10:00:00+09:00',
      end: '2026-09-14T10:30:00+09:00',
    };
    const reconciliationProposal = {
      event,
      reconciliation_token: 'kyberion-calendar-test-token',
    };
    expect(
      matchCalendarReconciliationEvents(reconciliationProposal, [
        {
          ...event,
          start: '2026-09-14T01:00:00Z',
          end: '2026-09-14T01:30:00Z',
          description: '[kyberion-calendar-test-token]',
        },
      ])
    ).toHaveLength(1);
    expect(
      matchCalendarReconciliationEvents(reconciliationProposal, [
        { ...event, description: '[kyberion-calendar-test-token]' },
        { ...event, summary: 'レビュー定例', description: '[kyberion-calendar-test-token]' },
      ])
    ).toHaveLength(2);
    expect(
      matchCalendarReconciliationEvents(reconciliationProposal, [
        { ...event, summary: '別の予定', description: '[kyberion-calendar-test-token]' },
      ])
    ).toHaveLength(0);
    expect(matchCalendarReconciliationEvents(reconciliationProposal, [event])).toHaveLength(0);
    expect(String(proposed.approval_request_id)).toBeTruthy();
    expect(() => calendarProposalPath(outDir, '../other-scope')).toThrow(
      'approval_request_id is invalid'
    );

    await expect(
      applyCalendarEvent({
        payload: { approval_request_id: String(proposed.approval_request_id) },
        context,
        outDir,
        confirmed: false,
      })
    ).rejects.toThrow('confirmed=true');

    await expect(
      applyCalendarEvent({
        payload: { approval_request_id: String(proposed.approval_request_id) },
        context,
        outDir,
        confirmed: true,
      })
    ).resolves.toMatchObject({ status: 'approval_required' });

    await expect(
      executePersonalWorkbenchAction({
        action: 'knowledge',
        payload: { summary: 'decision note' },
        context,
        evidenceRef: `${outDir}/missing-handoff.json`,
        outDir,
      })
    ).rejects.toThrow('knowledge enqueue requires an existing evidence handoff file');

    const actionsSource = readTextFile(
      pathResolver.rootResolve('scripts/personal-workbench/actions.ts')
    );
    expect(actionsSource).toContain('draft_mode: true');
    expect(actionsSource).toContain("delivery: 'local-only'");
    expect(actionsSource).toContain("status: 'approval_required'");
    expect(actionsSource).toContain(PERSONAL_WORKBENCH_APPROVAL_CHANNEL);
    expect(actionsSource).toContain('createCalendarEvent');
  });

  it('reconciles an uncertain provider write through an injectable fixture gateway', async () => {
    const context = {
      session_id: `pwb-fixture-${Date.now()}`,
      artifact_ref: 'active/shared/tmp/personal-workbench-fixture',
      viewer_principal: 'human:fixture',
      scope: { scope_kind: 'tenant' as const, tier: 'personal' as const, tenant_slug: 'default' },
    };
    const outDir = pathResolver.sharedTmp(`personal-workbench-reconcile-${Date.now()}`);
    const proposed = proposeCalendarEvent({
      payload: {
        summary: 'fixture event',
        start: '2026-09-15T01:00:00Z',
        end: '2026-09-15T01:30:00Z',
      },
      context,
      outDir,
      evidenceRef: `${outDir}/handoff.json`,
    });
    const requestId = String(proposed.approval_request_id);
    const approval = loadApprovalRequest(PERSONAL_WORKBENCH_APPROVAL_CHANNEL, requestId);
    expect(approval?.accountability?.payloadHash).toBeTruthy();
    decideApprovalRequest('mission_controller', {
      channel: PERSONAL_WORKBENCH_APPROVAL_CHANNEL,
      requestId,
      decision: 'approved',
      decidedBy: 'human:fixture',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'manual',
      payloadHash: approval?.accountability?.payloadHash,
      effectBinding: approval?.accountability?.effectBinding,
    });
    const gateway = {
      createCalendarEvent: async () => {
        throw new Error('fixture provider unavailable');
      },
      listCalendarAgenda: async () => ({
        calendar_id: 'primary',
        max_results: 50,
        ok: true,
        query: 'fixture event',
        time_min: '2026-09-15T01:00:00Z',
        time_max: '2026-09-15T01:30:00Z',
        total_items: 1,
        events: [
          {
            id: 'evt-fixture',
            summary: 'fixture event',
            start: '2026-09-15T01:00:00Z',
            end: '2026-09-15T01:30:00Z',
            description: '[kyberion-calendar-fixture]',
            hangout_link: '',
            html_link: '',
            location: '',
            status: 'confirmed',
          },
        ],
      }),
    };
    await expect(
      applyCalendarEvent({
        payload: { approval_request_id: requestId },
        context,
        outDir,
        confirmed: true,
        calendar_gateway: gateway,
      })
    ).rejects.toThrow('fixture provider unavailable');
    const proposal = readSafeJsonFile<{ reconciliation_token: string }>(
      calendarProposalPath(outDir, requestId),
      'fixture proposal'
    );
    gateway.listCalendarAgenda = async () => ({
      calendar_id: 'primary',
      max_results: 50,
      ok: true,
      query: 'fixture event',
      time_min: '2026-09-15T01:00:00Z',
      time_max: '2026-09-15T01:30:00Z',
      total_items: 1,
      events: [
        {
          id: 'evt-fixture',
          summary: 'fixture event',
          start: '2026-09-15T01:00:00Z',
          end: '2026-09-15T01:30:00Z',
          description: `[${proposal.reconciliation_token}]`,
          hangout_link: '',
          html_link: '',
          location: '',
          status: 'confirmed',
        },
      ],
    });
    await expect(
      reconcileCalendarEvent({
        payload: { approval_request_id: requestId },
        context,
        outDir,
        calendar_gateway: gateway,
      })
    ).resolves.toMatchObject({ status: 'reconciled' });
  });
});
