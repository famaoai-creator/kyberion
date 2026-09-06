import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

type DiscoveryOperation = {
  op?: string;
  input_schema?: Record<string, unknown>;
  examples?: Array<Record<string, unknown>>;
};

type DiscoveryActuator = {
  n?: string;
  ops?: DiscoveryOperation[];
};

type DiscoveryDocument = {
  actuators: DiscoveryActuator[];
};

const SELF_DESCRIBED_CATALOGS = [
  'agent',
  'android',
  'approval',
  'artifact',
  'blockchain',
  'browser',
  'build',
  'calendar',
  'code',
  'deployment',
  'email',
  'file',
  'ingest',
  'ios',
  'media',
  'media-generation',
  'meeting',
  'modeling',
  'network',
  'orchestrator',
  'presence',
  'process',
  'secret',
  'service',
  'terminal',
  'video-composition',
  'vision',
  'voice',
  'wisdom',
  'working-memory',
] as const;

describe('generate_op_registry discovery output', () => {
  it('includes input schemas and examples for contract-backed ops', () => {
    const discovery = JSON.parse(
      String(
        safeReadFile(pathResolver.knowledge('product/orchestration/actuator-op-discovery.json'), {
          encoding: 'utf8',
        }) || '{}'
      )
    ) as DiscoveryDocument;
    const browser = discovery.actuators.find((entry) => entry.n === 'browser-actuator');
    const system = discovery.actuators.find((entry) => entry.n === 'system-actuator');
    const file = discovery.actuators.find((entry) => entry.n === 'file-actuator');

    expect(browser?.ops?.find((item) => item.op === 'goto')).toMatchObject({
      input_schema: expect.objectContaining({
        required: ['url'],
      }),
      examples: expect.arrayContaining([expect.objectContaining({ url: 'https://example.com' })]),
    });
    expect(system?.ops?.find((item) => item.op === 'open_url')).toMatchObject({
      input_schema: expect.objectContaining({
        required: ['url'],
      }),
    });
    expect(system?.ops?.find((item) => item.op === 'app_quit')).toMatchObject({
      input_schema: expect.objectContaining({
        required: ['application'],
      }),
    });
    expect(system?.ops?.find((item) => item.op === 'process_kill')).toMatchObject({
      input_schema: expect.objectContaining({
        anyOf: expect.arrayContaining([
          expect.objectContaining({ required: ['pid'] }),
          expect.objectContaining({ required: ['name'] }),
        ]),
      }),
    });
    expect(file?.ops?.find((item) => item.op === 'read_json')).toMatchObject({
      input_schema: expect.objectContaining({
        required: ['path'],
      }),
      examples: expect.arrayContaining([
        expect.objectContaining({ path: 'knowledge/product/config.json' }),
      ]),
    });
  });

  it('publishes authored field contracts for every actuator dispatch', () => {
    const discovery = JSON.parse(
      String(
        safeReadFile(pathResolver.knowledge('product/orchestration/actuator-op-discovery.json'), {
          encoding: 'utf8',
        }) || '{}'
      )
    ) as DiscoveryDocument;
    const operations = discovery.actuators.flatMap((entry) => entry.ops || []);
    // Ratchet count regenerated via `pnpm generate:op-registry` against the
    // ops actually registered on disk (main added 7 ops since this literal
    // was last set); keep it in sync by regenerating rather than hand-editing
    // knowledge/product/orchestration/actuator-op-discovery.json.
    expect(operations).toHaveLength(574);
    expect(operations.every((item) => item.input_schema)).toBe(true);
    expect(operations.every((item) => Array.isArray(item.examples))).toBe(true);
    expect(
      operations.some((item) => item.input_schema?.['x-kyberion-contract'] === 'legacy-open')
    ).toBe(false);
    expect(
      operations.some((item) => item.input_schema?.['x-kyberion-contract'] === 'inferred-legacy')
    ).toBe(true);

    const agentSpawn = discovery.actuators
      .find((entry) => entry.n === 'agent-actuator')
      ?.ops?.find((item) => item.op === 'spawn');
    expect(agentSpawn?.input_schema).toMatchObject({
      properties: expect.objectContaining({
        provider: expect.any(Object),
        missionId: expect.any(Object),
      }),
    });
  });

  it('keeps self-described catalogs on the shared pipeline step type', () => {
    for (const actuator of SELF_DESCRIBED_CATALOGS) {
      const source = String(
        safeReadFile(
          pathResolver.rootResolve(`libs/actuators/${actuator}-actuator/src/op-catalog.ts`),
          { encoding: 'utf8' }
        ) || ''
      );
      expect(source, actuator).toContain('PipelineStepType');
      expect(source, actuator).not.toContain('OpSpecKind');
      expect(source, actuator).toMatch(
        /export function describeOps\(\): ActuatorOpDescription\[\]/
      );
    }

    const generator = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_op_registry.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(generator).not.toContain('PipelineOpKind');
    expect(generator).toContain('ActuatorOpDescription');
    expect(generator).toContain('loadDescribeOpsSources');
    expect(generator).not.toContain('describeOps as describe');
    expect(generator).toContain('loadActuatorOpRegistry()');
    expect(generator).toContain('defineCatalog<MediaManifestFile>');
    expect(generator).not.toContain('readJson<');
  });
});
