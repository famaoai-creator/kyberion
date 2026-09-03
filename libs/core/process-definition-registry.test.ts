import { describe, expect, it } from 'vitest';
import {
  assertProcessDefinitionRegistry,
  auditProcessDefinitionRegistry,
  loadProcessDefinitionRegistry,
} from './process-definition-registry.js';

describe('process definition registry', () => {
  it('declares all process-definition sources and their execution roles', () => {
    const registry = loadProcessDefinitionRegistry();
    expect(registry.sources.map((source) => source.id)).toEqual([
      'mission-workflow-catalog',
      'mission-orchestration-scenarios',
      'mission-task-classification-scenarios',
      'mission-playbooks',
      'mission-lifecycle-phases',
    ]);
    expect(registry.sources.map((source) => source.execution_role)).toEqual([
      'runtime',
      'validation',
      'validation',
      'knowledge',
      'protocol',
    ]);
  });

  it('checks the current catalog, scenario packs, playbooks, and phases', () => {
    const audit = auditProcessDefinitionRegistry();
    expect(audit.ok, audit.errors.join('\n')).toBe(true);
    expect(audit.sources[0]?.actual_counts).toEqual({ templates: 41, patterns: 7 });
    expect(audit.sources[1]?.actual_counts).toEqual({ scenarios: 24 });
    expect(audit.sources[2]?.actual_counts).toEqual({ scenarios: 26 });
    expect(audit.sources[3]?.missing_entries).toEqual([]);
    expect(audit.sources[4]?.missing_entries).toEqual([]);
    expect(audit.sources.every((source) => source.missing_consumer_paths?.length === 0)).toBe(true);
  });

  it('fails closed when a registered source disappears', () => {
    const registry = loadProcessDefinitionRegistry();
    const audit = auditProcessDefinitionRegistry({
      ...registry,
      sources: [{ ...registry.sources[0]!, path: 'knowledge/product/governance/missing.json' }],
    });
    expect(audit.ok).toBe(false);
    expect(audit.errors[0]).toContain('missing');
    expect(() => assertProcessDefinitionRegistry()).not.toThrow();
  });

  it('rejects registered source paths outside the repository root', () => {
    const registry = loadProcessDefinitionRegistry();
    expect(() =>
      auditProcessDefinitionRegistry({
        ...registry,
        sources: [{ ...registry.sources[0]!, path: '../outside.json' }],
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('validates registered JSON sources through their schema boundary', () => {
    const registry = loadProcessDefinitionRegistry();
    expect(() =>
      auditProcessDefinitionRegistry({
        ...registry,
        sources: [
          {
            ...registry.sources[0]!,
            path: 'knowledge/product/governance/process-definition-registry.json',
          },
        ],
      })
    ).toThrow('Invalid catalog process-definition-source-mission-workflow-catalog');
  });
});
