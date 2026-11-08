import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  config,
  type BooleanRegisteredEnvName,
  type RegisteredEnvName,
  type RegisteredEnvValueByName,
} from './config.js';
import { registerEnvironmentRegistryReader } from './env.js';

describe('foundation config facade', () => {
  afterEach(() => {
    registerEnvironmentRegistryReader(() => null);
  });

  it('reads typed registry values through the env accessor', () => {
    registerEnvironmentRegistryReader(() => ({
      entries: [
        { name: 'KYBERION_TENANT', type: 'string' },
        { name: 'KYBERION_ALLOW_LOCAL_NETWORK', type: 'boolean' },
        { name: 'KYBERION_AGENT_RING', type: 'number' },
      ],
    }));

    const env = {
      KYBERION_TENANT: 'acme',
      KYBERION_ALLOW_LOCAL_NETWORK: '1',
      KYBERION_AGENT_RING: '3',
    };

    expect(config.get('KYBERION_TENANT', { env })).toBe('acme');
    expect(config.text('KYBERION_TENANT', { env })).toBe('acme');
    expect(config.bool('KYBERION_ALLOW_LOCAL_NETWORK', { env })).toBe(true);
    expect(config.get('KYBERION_AGENT_RING', { env })).toBe(3);
  });

  it('sets and clears values on an explicit env bag', () => {
    const env: Record<string, string | undefined> = {};
    config.set('KYBERION_TENANT', 'beta', env);
    expect(env.KYBERION_TENANT).toBe('beta');
    config.set('KYBERION_TENANT', undefined, env);
    expect(env.KYBERION_TENANT).toBeUndefined();
  });

  it('keeps compile-time value types aligned with the generated map', () => {
    type Tenant = RegisteredEnvValueByName['KYBERION_TENANT'];
    type AllowLocal = RegisteredEnvValueByName['KYBERION_ALLOW_LOCAL_NETWORK'];
    expectTypeOf<Tenant>().toEqualTypeOf<string>();
    expectTypeOf<AllowLocal>().toEqualTypeOf<boolean>();
    expectTypeOf<BooleanRegisteredEnvName>().toMatchTypeOf<RegisteredEnvName>();
  });
});
