import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';

describe('protocol service boundary registry', () => {
  it('keeps non-surface services explicitly classified and scoped', () => {
    const registry = JSON.parse(
      safeReadFile('knowledge/product/governance/protocol-service-registry.json', {
        encoding: 'utf8',
      }) as string
    ) as { entries: Array<Record<string, unknown>> };
    const entries = new Map(registry.entries.map((entry) => [String(entry.id), entry]));
    expect(entries.get('peer-messaging')?.classification).toBe('protocol-gateway');
    expect(entries.get('mcp-server-cowork')?.classification).toBe('protocol-gateway');
    expect(entries.get('mcp-server-cowork')?.lifecycle_owner).toBe('service');
    expect(entries.get('review-checks')?.classification).toBe('control-plane-worker');
    expect(entries.get('report-review')?.classification).toBe('artifact-review-port');
    for (const entry of entries.values()) {
      expect(entry.process_scope).toBeTruthy();
      expect(entry.request_scope_mode).toBeTruthy();
      expect(entry.binding).toBeTruthy();
      expect(entry.principal_resolution).toBeTruthy();
      expect(entry.write_authority).toBeTruthy();
      expect(entry.nhi_binding).toBeTruthy();
      expect(Array.isArray(entry.approval_classes)).toBe(true);
      expect(entry.data_residency).toBeTruthy();
      expect(Array.isArray(entry.data_paths)).toBe(true);
      expect(Array.isArray(entry.lifecycle_actions)).toBe(true);
      expect(entry.lifecycle_actions).toContain('start');
      expect(entry.lifecycle_actions).toContain('stop');
    }
  });

  it('keeps every implemented MCP tool in the role/tier catalog', () => {
    const catalog = JSON.parse(
      safeReadFile('knowledge/product/governance/mcp-tool-catalog.json', {
        encoding: 'utf8',
      }) as string
    ) as { tools: Array<Record<string, unknown>> };
    const byName = new Map(catalog.tools.map((tool) => [String(tool.name), tool]));
    const implemented = [
      'kyberion.pipeline.list',
      'kyberion.pipeline.run',
      'kyberion.pipeline.job_status',
      'kyberion.knowledge.search',
      'kyberion.capability.list',
      'kyberion.service.actuate',
      'kyberion.mission.create',
      'kyberion.mission.status',
      'kyberion.mission.journal',
      'kyberion.surface.cowork.deliver',
      'kyberion.surface.cowork.list',
      'kyberion.knowledge.cowork_sync',
      'kyberion.approval.list_pending',
      'kyberion.approval.decide',
      'kyberion.audit.export',
      'kyberion.audit.verify',
    ];
    for (const name of implemented) {
      expect(byName.get(name), name).toBeTruthy();
      expect(byName.get(name)?.allowed_caller_roles, name).toEqual(expect.any(Array));
      expect(byName.get(name)?.allowed_tiers, name).toEqual(expect.any(Array));
    }
  });
});
