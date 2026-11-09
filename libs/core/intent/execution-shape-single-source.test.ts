import { describe, expect, it } from 'vitest';
import {
  EXECUTION_SHAPE_VALUES,
  INTENT_RESOLUTION_SHAPE_VALUES,
  ROUTE_FAMILY_VALUES,
  projectExecutionShapeToIntentResolutionShape,
  projectExecutionShapeToRouteFamily,
} from '../contracts/execution-shape.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile } from '../secure-io.js';
import {
  parseIntentResolutionContract,
  resolveIntentResolutionContract,
} from './intent-resolution-contract.js';
import {
  loadStandardIntentCatalog,
  withDerivedResolutionShape,
  type IntentResolutionPacket,
  type StandardIntentDefinition,
} from './intent-resolution.js';

interface StoredCatalogEntry {
  id?: string;
  intent_id?: string;
  execution_shape?: string;
  resolution?: { shape?: string };
}

function readCatalogFile(relativePath: string): StoredCatalogEntry[] {
  const raw = safeReadFile(pathResolver.knowledge(relativePath), { encoding: 'utf8' }) as string;
  return (JSON.parse(raw) as { intents: StoredCatalogEntry[] }).intents;
}

describe('ExecutionShape is the single execution vocabulary (concept model v2, D7)', () => {
  it('stores no resolution.shape in the base intent catalog (execution_shape is the source)', () => {
    const stored = readCatalogFile('product/governance/standard-intents.json')
      .filter((intent) => intent.resolution && 'shape' in intent.resolution)
      .map((intent) => `${intent.id}: ${intent.resolution?.shape} vs ${intent.execution_shape}`);
    expect(stored).toEqual([]);
  });

  it('keeps the intent-domain ontology on the same execution_shape as the catalog', () => {
    const catalog = new Map(
      readCatalogFile('product/governance/standard-intents.json').map((intent) => [
        intent.id,
        intent.execution_shape,
      ])
    );
    const drift = readCatalogFile('product/governance/intent-domain-ontology.json')
      .filter((entry) => catalog.has(entry.intent_id))
      .filter((entry) => entry.execution_shape !== catalog.get(entry.intent_id))
      .map((entry) => entry.intent_id);
    expect(drift).toEqual([]);
  });

  it('derives resolution.shape from execution_shape at load time', () => {
    const catalog = loadStandardIntentCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    for (const intent of catalog) {
      expect(intent.resolution?.shape, intent.id).toBe(intent.execution_shape);
    }
    // A stale value (e.g. from an overlay) loses to execution_shape.
    const stale = withDerivedResolutionShape({
      ...catalog[0],
      execution_shape: 'pipeline',
      resolution: { shape: 'task_session', result_shape: 'x' },
    } as StandardIntentDefinition);
    expect(stale.resolution).toEqual({ shape: 'pipeline', result_shape: 'x' });
  });

  it('projects every execution shape onto the legacy contract shape and route family', () => {
    const resolution = Object.fromEntries(
      EXECUTION_SHAPE_VALUES.map((shape) => [
        shape,
        projectExecutionShapeToIntentResolutionShape(shape),
      ])
    );
    expect(resolution).toEqual({
      direct_reply: 'direct_answer',
      actuator_action: 'task_session',
      browser_session: 'task_session',
      task_session: 'task_session',
      pipeline: 'task_session',
      mission: 'mission',
      project_bootstrap: 'project_bootstrap',
    });
    for (const value of Object.values(resolution)) {
      expect(INTENT_RESOLUTION_SHAPE_VALUES).toContain(value);
    }
    const route = Object.fromEntries(
      EXECUTION_SHAPE_VALUES.map((shape) => [shape, projectExecutionShapeToRouteFamily(shape)])
    );
    expect(route).toEqual({
      direct_reply: 'direct_reply',
      actuator_action: undefined,
      browser_session: 'browser_session',
      task_session: 'task_session',
      pipeline: 'pipeline',
      mission: 'mission',
      project_bootstrap: undefined,
    });
    for (const value of Object.values(route).filter(Boolean)) {
      expect(ROUTE_FAMILY_VALUES).toContain(value);
    }
  });

  it('carries the unfolded pipeline shape alongside the legacy task_session projection', () => {
    const packet: IntentResolutionPacket = {
      kind: 'intent_resolution_packet',
      utterance: 'reconcile the ecosystem',
      selected_intent_id: 'reconcile-ecosystem',
      selected_confidence: 0.95,
      selected_resolution: { shape: 'pipeline' },
      candidates: [],
    };
    const contract = resolveIntentResolutionContract(packet.utterance, { packet });
    expect(contract.resolution_shape).toBe('task_session');
    expect(contract.execution_shape).toBe('pipeline');
    expect(parseIntentResolutionContract(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
    // A carried execution_shape must agree with its projection.
    expect(
      parseIntentResolutionContract({ ...contract, execution_shape: 'mission' })
    ).toBeUndefined();
    // Contracts serialized before execution_shape existed still parse.
    const { execution_shape: _omitted, ...legacy } = contract;
    expect(parseIntentResolutionContract(legacy)).toEqual(legacy);
  });
});
