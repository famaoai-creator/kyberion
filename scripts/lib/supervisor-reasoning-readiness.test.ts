import { describe, expect, it, vi } from 'vitest';
import type { CredentialBindingReadiness } from '@agent/core/secret/secret-guard';
import { createSupervisorReasoningRefresh } from './supervisor-reasoning-readiness.js';

function harness(initial: CredentialBindingReadiness = { status: 'operator', identity: {} }) {
  let readiness = initial;
  const inspect = vi.fn(() => readiness);
  const install = vi.fn(() => true);
  const reselect = vi.fn(() => true);
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  return {
    inspect,
    install,
    reselect,
    logger,
    setReadiness: (next: CredentialBindingReadiness) => {
      readiness = next;
    },
    refresh: createSupervisorReasoningRefresh({ inspect, install, reselect, logger }),
  };
}

describe('supervisor reasoning prerequisites', () => {
  it('waits without provider attempts or repeated warnings when tenant binding is absent', () => {
    const h = harness({ status: 'binding_required', identity: { tenantSlug: 'tenant-a' } });
    expect(h.refresh.refresh()).toBe(false);
    expect(h.refresh.refresh()).toBe(false);
    expect(h.inspect).toHaveBeenCalledTimes(2);
    expect(h.install).not.toHaveBeenCalled();
    expect(h.reselect).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.refresh.snapshot()).toEqual({
      status: 'binding_required',
      reason_code: 'CREDENTIAL_BINDING_REQUIRED',
    });
  });

  it('recovers when a matching task binding becomes available, then periodically refreshes', () => {
    const h = harness({ status: 'binding_required', identity: { tenantSlug: 'tenant-a' } });
    h.refresh.refresh();
    h.setReadiness({ status: 'bound', identity: { tenantSlug: 'tenant-a', taskId: 'task-a' } });
    expect(h.refresh.refresh()).toBe(true);
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(h.refresh.snapshot()).toEqual({ status: 'ready' });
    h.refresh.refresh();
    expect(h.reselect).toHaveBeenCalledTimes(1);
  });

  it('reports scope contradictions once without treating them as ready or missing keys', () => {
    const h = harness();
    h.inspect.mockImplementation(() => {
      throw new Error('[CREDENTIAL_SCOPE_DENIED] Runtime and resource identities contradict');
    });
    h.refresh.refresh();
    h.refresh.refresh();
    expect(h.install).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.refresh.snapshot().status).toBe('scope_denied');
    h.inspect.mockImplementation(() => ({ status: 'operator', identity: {} }));
    expect(h.refresh.refresh()).toBe(true);
  });

  it('allows recovery after provider configuration changes without changing task identity', () => {
    const h = harness({ status: 'bound', identity: { tenantSlug: 'tenant-a', taskId: 'task-a' } });
    h.install.mockImplementationOnce(() => {
      throw new Error('[CREDENTIAL_SCOPE_DENIED] invalid provider configuration');
    });
    expect(h.refresh.refresh()).toBe(false);
    expect(h.refresh.snapshot().status).toBe('scope_denied');
    expect(h.refresh.refresh()).toBe(true);
    expect(h.install).toHaveBeenCalledTimes(2);
  });
  it('continues periodic attempts for a transient provider failure and exposes unavailable state', () => {
    const h = harness();
    h.install.mockImplementationOnce(() => {
      throw new Error('provider temporarily unavailable');
    });
    expect(h.refresh.refresh()).toBe(false);
    expect(h.refresh.snapshot()).toEqual({
      status: 'unavailable',
      reason_code: 'BACKEND_REFRESH_FAILED',
    });
    expect(h.refresh.refresh()).toBe(true);
    expect(h.install).toHaveBeenCalledTimes(2);
  });

  it('does not downgrade mixed binding and scope failures to a missing binding', () => {
    const h = harness();
    h.install.mockImplementationOnce(() => {
      throw new Error('[CREDENTIAL_BINDING_REQUIRED] wrapped [CREDENTIAL_SCOPE_DENIED]');
    });
    expect(h.refresh.refresh()).toBe(false);
    expect(h.refresh.snapshot()).toEqual({
      status: 'scope_denied',
      reason_code: 'CREDENTIAL_SCOPE_DENIED',
    });
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it('does not report a successful installation when only stubs remain', () => {
    const h = harness();
    h.install.mockReturnValue(false);
    expect(h.refresh.refresh()).toBe(false);
    expect(h.refresh.snapshot()).toEqual({
      status: 'unavailable',
      reason_code: 'BACKEND_UNAVAILABLE',
    });
    expect(h.logger.info).not.toHaveBeenCalled();
    expect(h.refresh.refresh()).toBe(true);
    expect(h.reselect).toHaveBeenCalledTimes(1);
  });
});
