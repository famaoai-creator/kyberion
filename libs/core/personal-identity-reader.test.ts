import { describe, expect, it } from 'vitest';
import {
  parsePersonalAgentIdentity,
  parsePersonalAgentIdentitySummary,
  parsePersonalSovereignIdentity,
  parsePersonalSovereignIdentitySummary,
} from './personal-identity-reader.js';

describe('personal identity reader', () => {
  it('projects only the display fields shared by surfaces', () => {
    expect(parsePersonalSovereignIdentity({ name: ' Operator ', secret: 'hidden' })).toEqual({
      name: 'Operator',
    });
    expect(parsePersonalAgentIdentity({ agent_id: 'agent-1', trust_tier: 'T2' })).toEqual({
      agent_id: 'agent-1',
      trust_tier: 'T2',
    });
  });

  it('rejects malformed identity field shapes before projection', () => {
    expect(parsePersonalSovereignIdentity({ name: 42 })).toBeNull();
    expect(parsePersonalAgentIdentity({ agent_id: ['agent-1'] })).toBeNull();
    expect(parsePersonalAgentIdentity(null)).toBeNull();
  });

  it('projects the extended fields used by Chronos without exposing unknown data', () => {
    expect(
      parsePersonalSovereignIdentitySummary({
        name: ' Operator ',
        language: 'ja',
        interaction_style: 'concise',
        primary_domain: 'operations',
        status: 'active',
        secret: 'hidden',
      })
    ).toEqual({
      name: 'Operator',
      language: 'ja',
      interaction_style: 'concise',
      primary_domain: 'operations',
      status: 'active',
    });
    expect(
      parsePersonalAgentIdentitySummary({
        agent_id: 'agent-1',
        role: 'assistant',
        owner: 'operator',
        trust_tier: 'T2',
        secret: 'hidden',
      })
    ).toEqual({ agent_id: 'agent-1', role: 'assistant', owner: 'operator', trust_tier: 'T2' });
  });

  it('rejects malformed extended fields before the Chronos projection', () => {
    expect(parsePersonalSovereignIdentitySummary({ name: 'Operator', status: 42 })).toBeNull();
    expect(
      parsePersonalAgentIdentitySummary({ agent_id: 'agent-1', owner: ['operator'] })
    ).toBeNull();
  });
});
