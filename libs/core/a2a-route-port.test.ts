import { describe, expect, it } from 'vitest';
import { registerA2ARoute, getA2ARoute, type A2ARoute } from './a2a-route-port.js';
import { coreSeamCatalog } from './seam.js';

describe('a2a-route-port', () => {
  it('rejects replacement of the canonical route', async () => {
    const first: A2ARoute = async (envelope) => envelope;
    const second: A2ARoute = async (envelope) => envelope;

    const dispose = registerA2ARoute(first);

    expect(() => registerA2ARoute(second)).toThrow('[A2A_ROUTE_ALREADY_REGISTERED]');
    expect(getA2ARoute()).toBe(first);
    expect(coreSeamCatalog.get('a2a-route')?.multiplicity).toBe('sole');
    dispose();
    expect(getA2ARoute()).toBeUndefined();
  });
});
