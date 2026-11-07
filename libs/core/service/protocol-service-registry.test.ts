import { describe, expect, it } from 'vitest';
import {
  assertProtocolServiceRegistered,
  getProtocolServiceRegistryEntry,
  loadProtocolServiceRegistry,
} from './protocol-service-registry.js';

describe('protocol service registry loader', () => {
  it('loads all registered non-surface services with scope metadata', () => {
    const entries = loadProtocolServiceRegistry();
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(getProtocolServiceRegistryEntry('mcp-server-cowork').classification).toBe(
      'protocol-gateway'
    );
    expect(getProtocolServiceRegistryEntry('report-review').request_scope_mode).toBe(
      'artifact-derived'
    );
    expect(getProtocolServiceRegistryEntry('mcp-server-cowork')).toMatchObject({
      principal_resolution: 'server-bound-mcp-session',
      write_authority: 'catalog-tool-and-approval-gate',
      nhi_binding: 'server-bound-mcp-nhi',
      approval_classes: ['tool-catalog', 'human-final'],
    });
  });

  it('fails closed for an unknown service', () => {
    expect(() => assertProtocolServiceRegistered('unknown-service')).toThrow(
      'PROTOCOL_SERVICE_NOT_REGISTERED'
    );
  });
});
