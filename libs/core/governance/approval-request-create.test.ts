import { afterEach, describe, expect, it } from 'vitest';
// Registers the verb-axis bridge with the authorization registry.
import '../foundation/command-credential-policy.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { approvalStoreRoots } from './approval-store-paths.js';
import { admitInternalDecision } from './approval-request-create.js';

const CHANNELS = ['external-operation', 'inbox'];

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    for (const root of Object.values(approvalStoreRoots())) {
      for (const channel of CHANNELS) {
        const dir = pathResolver.rootResolve(`${root}/${channel}`);
        if (safeExistsSync(dir)) safeRmSync(dir);
      }
    }
  });
});

const base = {
  channel: 'slack',
  threadTs: 'subject-fixture',
  correlationId: 'subject-fixture',
  requestedBy: 'test-requester',
  draft: { title: 'Subject fixture', summary: 'Internal admission routing' },
};

describe('admitInternalDecision', () => {
  it('derives the storage domain from the subject declaration', () => {
    // External-admission subjects route their human approval to the
    // 'external-operation' domain — the declaration, not a call-site literal.
    const { record, authorization } = admitInternalDecision('mission_controller', {
      ...base,
      subject: 'vcs:pr_merge',
    });
    expect(authorization.declared).toBe(true);
    expect(authorization.effectClass).toBe('external_mutation');
    expect(record.storageChannel).toBe('external-operation');
    expect(record.channel).toBe('slack');
    expect(record.subject).toBe('vcs:pr_merge');
    expect(record.status).toBe('pending');
  });

  it('keeps an explicit storageChannel on declaration mismatch (measurement-first)', () => {
    const { record } = admitInternalDecision('mission_controller', {
      ...base,
      subject: 'vcs:pr_merge',
      storageChannel: 'inbox',
    });
    expect(record.storageChannel).toBe('inbox');
  });

  it('falls back to the channel when the subject declares no domain', () => {
    const { record, authorization } = admitInternalDecision('mission_controller', {
      ...base,
      subject: 'verb:mission:help',
      channel: 'inbox',
    });
    // verb axis: 'none' requirement → local/free, no approvalDomain → channel fallback.
    expect(authorization.declared).toBe(true);
    expect(authorization.detail).toEqual({
      kind: 'credential-requirement',
      requirement: 'none',
    });
    expect(record.storageChannel).toBe('inbox');
  });

  it('does not repartition storage for an undeclared subject', () => {
    // An undeclared subject resolves to the external fail-safe for AUTHORITY,
    // but it never proved it belongs in 'external-operation' — storage stays
    // on the caller's channel.
    const { record, authorization } = admitInternalDecision('mission_controller', {
      ...base,
      subject: 'op:undeclared-thing',
      channel: 'inbox',
    });
    expect(authorization.declared).toBe(false);
    expect(record.storageChannel).toBe('inbox');
  });
});
