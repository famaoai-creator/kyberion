import { describe, expect, it } from 'vitest';
import { parseIdentityResponse } from './identity-response.js';

const validIdentity = {
  status: 'ok',
  onboarded: true,
  sovereign: {
    name: 'Operator',
    language: 'en',
    interaction_style: 'concise',
    primary_domain: 'operations',
    status: 'active',
  },
  agent: {
    agent_id: 'agent-1',
    role: 'operator',
    owner: 'operator',
    trust_tier: 'trusted',
  },
  vision: 'A bounded vision',
};

describe('parseIdentityResponse', () => {
  it('normalizes the identity response to the fields consumed by the UI', () => {
    expect(parseIdentityResponse({ ...validIdentity, ignored: { value: true } })).toEqual(
      validIdentity
    );
  });

  it('accepts the not-onboarded shape with nullable identity records', () => {
    expect(
      parseIdentityResponse({
        status: 'ok',
        onboarded: false,
        sovereign: null,
        agent: null,
        vision: null,
      })
    ).toEqual({
      status: 'ok',
      onboarded: false,
      sovereign: null,
      agent: null,
      vision: null,
    });
  });

  it('rejects malformed fields and dangerous nested keys', () => {
    expect(parseIdentityResponse({ ...validIdentity, onboarded: 'true' })).toBeUndefined();
    expect(
      parseIdentityResponse({
        ...validIdentity,
        agent: { ...validIdentity.agent, constructor: { polluted: true } },
      })
    ).toBeUndefined();
  });
});
