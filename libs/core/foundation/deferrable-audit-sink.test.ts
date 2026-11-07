/**
 * Boundary contract for the zero-dependency audit sink: symmetric provider /
 * consumer registration, bounded pending queues, and never-throw semantics.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  provideAuditIo,
  recordDeferrableAudit,
  recordGovernanceActionReport,
  registerAuditIoConsumer,
  registerDeferrableAuditRecorder,
  registerGovernanceActionRecorder,
} from './deferrable-audit-sink.js';

describe('deferrable-audit-sink', () => {
  it('queues audit records until a recorder registers, then flushes in order', () => {
    const channel = `q-${Math.random().toString(36).slice(2)}`;
    recordDeferrableAudit({ agentId: 'a', action: channel, operation: 'op', result: 'failed' });
    recordDeferrableAudit({ agentId: 'b', action: channel, operation: 'op', result: 'failed' });
    const seen: string[] = [];
    registerDeferrableAuditRecorder((r) => {
      if (r.action === channel) seen.push(r.agentId);
    });
    // Registration replaced the previous recorder: records submitted now go
    // to the latest recorder; the two queued above flushed already.
    recordDeferrableAudit({ agentId: 'c', action: channel, operation: 'op', result: 'failed' });
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('never throws when the recorder itself throws', () => {
    registerDeferrableAuditRecorder(() => {
      throw new Error('boom');
    });
    expect(() =>
      recordDeferrableAudit({ agentId: 'x', action: 'y', operation: 'op', result: 'failed' })
    ).not.toThrow();
  });

  it('queues governance reports until a recorder registers', () => {
    const seen: string[] = [];
    recordGovernanceActionReport({
      agentId: 'g',
      operation: 'file_write',
      reason: 'denied',
      policyViolation: true,
    });
    registerGovernanceActionRecorder((r) => seen.push(r.reason));
    expect(seen.length).toBeGreaterThan(0);
  });

  it('connects audit-io provider and consumer in either order', () => {
    const channel = `io-${Math.random().toString(36).slice(2)}`;
    const consumer = vi.fn();
    // consumer first
    registerAuditIoConsumer(channel, consumer);
    provideAuditIo(channel, { read: () => 'x' });
    expect(consumer).toHaveBeenCalledWith({ read: expect.any(Function) });
    // provider first
    const channel2 = `io-${Math.random().toString(36).slice(2)}`;
    provideAuditIo(channel2, { read: () => 'y' });
    const late = vi.fn();
    registerAuditIoConsumer(channel2, late);
    expect(late).toHaveBeenCalledWith({ read: expect.any(Function) });
  });
});
