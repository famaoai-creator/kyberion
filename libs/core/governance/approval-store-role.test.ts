import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';
import { GOVERNED_ARTIFACT_ROLES } from '../workforce/artifact-store.js';
import {
  approvalEventLogicalPath,
  approvalStoreRoots,
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
  tenantApprovalRequestLogicalPath,
  writeApprovalJsonAt,
} from './approval-store.js';

const channel = `localadmin-${randomUUID()}`;

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    for (const root of Object.values(approvalStoreRoots())) {
      const dir = pathResolver.rootResolve(`${root}/${channel}`);
      if (safeExistsSync(dir)) safeRmSync(dir);
    }
  });
});

function request(humanOnly = false) {
  return createApprovalRequest('mission_controller', {
    channel,
    threadTs: 'fixture-thread',
    correlationId: 'localadmin-role-fixture',
    requestedBy: 'test-requester',
    draft: { title: 'Approval writer fixture', summary: 'No external effect' },
    ...(humanOnly ? { accountability: { finalDecision: 'human_only' as const } } : {}),
  });
}

describe('approval-specific localadmin writer', () => {
  it('records and reads a decision and event as the existing localadmin identity', () => {
    const record = request();
    const updated = decideApprovalRequest('chronos_localadmin', {
      channel,
      requestId: record.id,
      decision: 'approved',
      decidedBy: 'chronos-localadmin',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'local_admin_token',
    });
    expect(updated.status).toBe('approved');
    expect(updated.decidedBy).toBe('chronos-localadmin');
    expect(loadApprovalRequest(channel, record.id)?.status).toBe('approved');
    const events = String(safeReadFile(pathResolver.rootResolve(approvalEventLogicalPath(channel))))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'approved',
        request_id: record.id,
        decided_by: 'chronos-localadmin',
        auth_method: 'local_admin_token',
      })
    );
  });

  it('does not let a localadmin storage writer bypass authenticated human proof', () => {
    const record = request(true);
    expect(() =>
      decideApprovalRequest('chronos_localadmin', {
        channel,
        requestId: record.id,
        decision: 'approved',
        decidedBy: 'chronos-localadmin',
        decidedByType: 'human',
        authenticated: false,
      })
    ).toThrow('human decider');
    expect(loadApprovalRequest(channel, record.id)?.status).toBe('pending');
    expect(() =>
      decideApprovalRequest('chronos_localadmin', {
        channel,
        requestId: record.id,
        decision: 'approved',
        decidedBy: 'chronos-localadmin',
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'local_admin_token',
      })
    ).toThrow('is not sufficient');
    expect(loadApprovalRequest(channel, record.id)?.status).toBe('pending');
  });

  it('keeps channel permission checks for a writer not allowed to own approvals', () => {
    const partition = {
      kind: 'tenant' as const,
      tier: 'confidential' as const,
      tenant_slug: 'localadmin-fixture',
    };
    const id = randomUUID();
    const logical = tenantApprovalRequestLogicalPath(partition, channel, id);
    expect(() => writeApprovalJsonAt('chronos_gateway', partition, logical, {})).toThrow(
      'caller may not write this channel'
    );
    expect(safeExistsSync(pathResolver.rootResolve(logical))).toBe(false);
  });

  it('does not add localadmin to generic artifact writers or surface role mappings', () => {
    expect(GOVERNED_ARTIFACT_ROLES).not.toContain('chronos_localadmin');
  });
});
