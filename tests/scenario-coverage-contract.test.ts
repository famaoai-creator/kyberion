import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadActuatorManifestCatalog, pathResolver } from '@agent/core';
import { safeExistsSync, safeReadFile } from '@agent/core';

function readJson(relativePath: string): any {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string
  );
}

function collectPipelineOps(node: unknown, ops = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectPipelineOps(item, ops);
    return ops;
  }
  if (!node || typeof node !== 'object') return ops;

  const record = node as Record<string, unknown>;
  if (typeof record.op === 'string') ops.add(record.op);

  for (const value of Object.values(record)) {
    collectPipelineOps(value, ops);
  }
  return ops;
}

function collectDomains(ops: Iterable<string>): string[] {
  return [...new Set([...ops].map((op) => (op.includes(':') ? op.split(':', 1)[0] : op)))].sort();
}

describe('scenario coverage contracts', () => {
  it('keeps the documented scenario references pointing at real playbooks and pipelines', () => {
    const scenarioDoc = safeReadFile(pathResolver.rootResolve('docs/SCENARIOS.md'), { encoding: 'utf8' }) as string;

    expect(scenarioDoc).toContain('[product-audit](knowledge/product/orchestration/mission-playbooks/product-audit.md)');
    expect(scenarioDoc).toContain('[ceo-strategic-report](../pipelines/ceo-strategic-report.json)');

    expect(
      safeExistsSync(pathResolver.rootResolve('knowledge/product/orchestration/mission-playbooks/product-audit.md'))
    ).toBe(true);
    expect(safeExistsSync(pathResolver.rootResolve('pipelines/ceo-strategic-report.json'))).toBe(true);
    expect(safeExistsSync(pathResolver.rootResolve('knowledge/product/orchestration/mission-playbooks/ceo-strategy.md'))).toBe(true);
  });

  it('keeps the scenario packs populated with the flagship multi-actuator scenarios', () => {
    const orchestrationPack = readJson('knowledge/product/governance/mission-orchestration-scenario-pack.json') as {
      scenarios?: Array<{ scenario_id?: string; notes?: string }>;
    };

    const ids = new Set((orchestrationPack.scenarios || []).map((scenario) => scenario.scenario_id).filter(Boolean));
    expect(ids.has('golden-voice-video-pipeline')).toBe(true);
    expect(ids.has('golden-meeting-proxy-live-participation')).toBe(true);
    expect(ids.has('golden-ai-meeting-facilitator-action-items')).toBe(true);
    expect(ids.has('golden-governed-board-meeting-video')).toBe(true);
    expect(ids.has('golden-deterministic-monthly-report-patrol')).toBe(true);

    const notes = (orchestrationPack.scenarios || []).map((scenario) => scenario.notes || '').join('\n');
    expect(notes).toMatch(/voice\/video|meeting|dashboard patrol|deterministic/i);
  });

  it('keeps the canonical actuator archetype targets backed by manifests', () => {
    const manifestCatalog = loadActuatorManifestCatalog();
    const manifestNames = new Set(manifestCatalog.map((entry) => entry.n));
    const archetypePack = readJson('knowledge/product/orchestration/actuator-request-archetypes.json') as {
      archetypes?: Array<{ id?: string; target_actuators?: string[] }>;
    };

    const targetedActuators = new Set(
      (archetypePack.archetypes || []).flatMap((archetype) => archetype.target_actuators || [])
    );

    expect(manifestNames.size).toBeGreaterThan(0);
    for (const actuator of targetedActuators) {
      expect(
        manifestNames.has(actuator),
        `missing actuator manifest for target_actuator=${actuator}`
      ).toBe(true);
    }
  });

  it('keeps representative pipelines spanning multiple actuator domains', () => {
    const representativePipelines = [
      {
        path: 'pipelines/ceo-strategic-report.json',
        expectedDomains: ['code', 'system'],
      },
      {
        path: 'pipelines/contract-review.json',
        expectedDomains: ['media', 'wisdom'],
      },
      {
        path: 'pipelines/executive-narrative-bridge.json',
        expectedDomains: ['reasoning', 'system', 'wisdom'],
      },
    ];

    for (const { path: pipelinePath, expectedDomains } of representativePipelines) {
      const pipeline = readJson(pipelinePath);
      const domains = collectDomains(collectPipelineOps(pipeline));

      for (const expectedDomain of expectedDomains) {
        expect(
          domains.includes(expectedDomain),
          `${pipelinePath} did not include expected domain ${expectedDomain}; domains=${domains.join(', ')}`
        ).toBe(true);
      }
    }
  });

  it('keeps the media review and marketing pipelines aligned with the working op shapes', () => {
    const marketingOps = collectPipelineOps(readJson('pipelines/marketing-content.json'));
    expect(marketingOps.has('media:document_diagram_asset_from_brief')).toBe(true);
    expect(marketingOps.has('media:apply_theme')).toBe(true);
    expect(marketingOps.has('media:apply_pattern')).toBe(true);
    expect(marketingOps.has('media:merge_content')).toBe(true);
    expect(marketingOps.has('media:pptx_render')).toBe(true);

    const reviewOps = collectPipelineOps(readJson('pipelines/contract-review.json'));
    expect(reviewOps.has('media:document_digest')).toBe(true);
    expect(reviewOps.has('media:write_file')).toBe(true);
    expect(reviewOps.has('wisdom:a2a_fanout')).toBe(true);
    expect(reviewOps.has('wisdom:cross_critique')).toBe(true);
    expect(reviewOps.has('wisdom:emit_dissent_log')).toBe(true);
  });
});
