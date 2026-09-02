import { describe, expect, it } from 'vitest';
import {
  parsePersonalAgentIdentity,
  parsePersonalSovereignIdentity,
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
});
