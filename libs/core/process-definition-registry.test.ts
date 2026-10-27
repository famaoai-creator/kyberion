import { describe, expect, it } from 'vitest';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
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
    expect(audit.sources[0]?.actual_counts).toEqual({ templates: 79, patterns: 8 });
    expect(audit.sources[1]?.actual_counts).toEqual({ scenarios: 25 });
    expect(audit.sources[2]?.actual_counts).toEqual({ scenarios: 33 });
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

  it('audits a new source identity using only its declared schema', () => {
    const registry = loadProcessDefinitionRegistry();
    const audit = auditProcessDefinitionRegistry({
      ...registry,
      sources: [{ ...registry.sources[1]!, id: 'new-organization-process-scenarios' }],
    });
    expect(audit.ok, audit.errors.join('\n')).toBe(true);
    expect(audit.sources[0]?.id).toBe('new-organization-process-scenarios');
    expect(audit.sources[0]?.actual_counts).toEqual({ scenarios: 25 });
  });

  it('rejects a JSON source without a declared schema', () => {
    const registry = loadProcessDefinitionRegistry();
    expect(() =>
      auditProcessDefinitionRegistry({
        ...registry,
        sources: [{ ...registry.sources[0]!, schema: undefined }],
      })
    ).toThrow('[PROCESS_DEFINITION] no schema registered');
  });

  it.each([
    '../outside.schema.json',
    '/tmp/outside.schema.json',
    'https://example.com/outside.schema.json',
    'knowledge/product/schemas/../governance/outside.schema.json',
    'knowledge/product/schemas\\outside.schema.json',
    'knowledge/personal/outside.schema.json',
  ])('rejects a schema reference outside the governed schema namespace: %s', (schema) => {
    const registry = loadProcessDefinitionRegistry();
    expect(() =>
      auditProcessDefinitionRegistry({
        ...registry,
        sources: [{ ...registry.sources[0]!, schema }],
      })
    ).toThrow('[PROCESS_DEFINITION] invalid governed schema path');
  });

  it('rejects a missing governed schema file', () => {
    const registry = loadProcessDefinitionRegistry();
    expect(() =>
      auditProcessDefinitionRegistry({
        ...registry,
        sources: [
          {
            ...registry.sources[0]!,
            schema: 'knowledge/product/schemas/missing-process-definition.schema.json',
          },
        ],
      })
    ).toThrow();
  });

  it('requires JSON schema declarations at the registry schema boundary', () => {
    const registry = loadProcessDefinitionRegistry();
    const catalog = defineCatalog({
      id: 'process-definition-registry-test',
      path: pathResolver.knowledge('product/governance/process-definition-registry.json'),
      schema: pathResolver.knowledge('product/schemas/process-definition-registry.schema.json'),
    });
    expect(() =>
      catalog.validate({
        ...registry,
        sources: [{ ...registry.sources[0]!, schema: undefined }],
      })
    ).toThrow("required property 'schema'");
    expect(() =>
      catalog.validate({
        ...registry,
        sources: [{ ...registry.sources[3]!, schema: registry.sources[0]!.schema }],
      })
    ).toThrow('must NOT be valid');
  });
});
