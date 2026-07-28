// DA-03 acceptance (3): the knowledge-sync no-op is resolved. The v2
// pipeline silently did nothing because knowledge-sync-rules.json had no
// `jobs` key and the loop body called a removed op. This contract pins:
//   - the jobs registry exists with the documented shape,
//   - tenant-ingest.json actually wires jobs → ingest:sync_source,
//   - knowledge-sync.json is a real delegation (core:include tenant-ingest),
//     not a loop over a channel that can never resolve.
// DA-03 acceptance (4) is runtime-verified separately (a scheduled/manual
// run_pipeline run persists a trace); this suite is the static half.
import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';

function readJson(relative: string): Record<string, any> {
  return JSON.parse(safeReadFile(relative, { encoding: 'utf8' }) as string);
}

describe('DA-03 tenant-ingest wiring contract', () => {
  const rules = readJson('knowledge/product/governance/knowledge-sync-rules.json');
  const tenantIngest = readJson('pipelines/tenant-ingest.json');
  const knowledgeSync = readJson('pipelines/knowledge-sync.json');

  it('knowledge-sync-rules.json has a real jobs registry with the documented shape', () => {
    expect(Array.isArray(rules.jobs), 'jobs must be an array').toBe(true);
    for (const job of rules.jobs) {
      expect(typeof job.id).toBe('string');
      expect(typeof job.tenant_slug).toBe('string');
      expect(['box', 'slack', 'confluence']).toContain(job.source_system);
      expect(job.source_params).toBeTypeOf('object');
      expect(typeof job.enabled).toBe('boolean');
      expect(typeof job.dry_run).toBe('boolean');
    }
    const ids = rules.jobs.map((job: any) => job.id);
    expect(new Set(ids).size, 'job ids must be unique').toBe(ids.length);
  });

  it('DA-06 pii_patterns shape survives the jobs addition (pii-scrubber loader input)', () => {
    const patterns = rules.security?.pii_patterns;
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThanOrEqual(10);
    for (const pattern of patterns) {
      expect(typeof pattern.id).toBe('string');
      expect(typeof pattern.regex).toBe('string');
      expect(['secret', 'pii']).toContain(pattern.severity);
      expect(['block', 'mask']).toContain(pattern.action);
    }
  });

  it('tenant-ingest.json foreaches the jobs registry into ingest:sync_source', () => {
    const loadStep = tenantIngest.steps.find((step: any) => step.id === 'load-jobs');
    expect(loadStep.params.path).toBe('knowledge/product/governance/knowledge-sync-rules.json');
    expect(loadStep.produces.channel).toBe('sync_config');
    // Must be read_json (parsed object): system:read_file exports the raw
    // untrusted-wrapped TEXT, so {{sync_config.jobs}} would silently resolve
    // to '' and core:foreach would no-op — the exact failure mode of v2.
    expect(loadStep.op).toBe('system:read_json');

    const foreachStep = tenantIngest.steps.find((step: any) => step.op === 'core:foreach');
    expect(foreachStep.params.items).toBe('{{sync_config.jobs}}');
    const serialized = JSON.stringify(foreachStep.params.do);
    expect(serialized).toContain('ingest:sync_source');
    // enabled gate: disabled example jobs must be skipped, not executed
    expect(serialized).toContain('"from":"sync_job.enabled"');
  });

  it('tenant-ingest.json is cron-scheduled', () => {
    expect(tenantIngest.schedule).toMatchObject({
      id: 'tenant-ingest',
      timezone: 'Asia/Tokyo',
      enabled: true,
    });
    expect(String(tenantIngest.schedule.cron)).toMatch(/^\S+ \S+ \* \* \*$/); // daily
  });

  it('knowledge-sync.json is no longer a no-op: it delegates to tenant-ingest via core:include', () => {
    const include = knowledgeSync.steps.find((step: any) => step.op === 'core:include');
    expect(include.params.fragment).toBe('pipelines/tenant-ingest.json');
    // the dead v2 wiring must be gone
    expect(JSON.stringify(knowledgeSync.steps)).not.toContain('wisdom:knowledge_inject');
  });
});
