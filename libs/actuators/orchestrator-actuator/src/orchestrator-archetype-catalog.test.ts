import { describe, expect, it } from 'vitest';
import { parseActuatorRequestArchetypeCatalog } from './orchestrator-archetype-catalog.js';

const validCatalog = {
  default_archetype: 'structured-delivery',
  archetypes: [
    {
      id: 'structured-delivery',
      trigger_keywords: ['build', '作って'],
      summary_template: 'Structured delivery.',
      normalized_scope: ['request-normalization'],
      target_actuators: ['orchestrator-actuator'],
      deliverables: ['execution brief'],
      required_inputs: ['objective'],
    },
  ],
};

describe('parseActuatorRequestArchetypeCatalog', () => {
  it('accepts the governed catalog shape', () => {
    expect(parseActuatorRequestArchetypeCatalog(validCatalog)).toEqual(validCatalog);
  });

  it.each([
    null,
    [],
    { ...validCatalog, default_archetype: 'missing' },
    { ...validCatalog, archetypes: [] },
    {
      ...validCatalog,
      archetypes: [{ ...validCatalog.archetypes[0], required_inputs: [''] }],
    },
    {
      ...validCatalog,
      archetypes: [{ ...validCatalog.archetypes[0], target_actuators: 'orchestrator-actuator' }],
    },
  ])('rejects malformed catalog: %j', (value) => {
    expect(parseActuatorRequestArchetypeCatalog(value)).toBeNull();
  });
});
