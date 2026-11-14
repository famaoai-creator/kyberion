import { describe, expect, it, vi } from 'vitest';
import {
  GWS_SESSION_MATERIAL_LIMITS,
  preflightGwsSessionRegistration,
  validateGwsSessionMaterial,
  type GwsSessionRegistrationTarget,
} from './gws-session-registration-contract.js';

const material = () => ({
  type: 'authorized_user',
  client_id: 'synthetic-client.apps.googleusercontent.com',
  client_secret: 'synthetic-client-secret',
  refresh_token: 'synthetic-refresh-token',
});
const target = (): GwsSessionRegistrationTarget => ({
  bindingId: 'acme-gws',
  serviceId: 'google-workspace',
  ownerKind: 'organization',
  ownerRef: 'acme',
  tenantSlug: 'acme',
  authMode: 'session',
  expectedGeneration: null,
});

describe('GWS portable session material', () => {
  it('accepts an exact authorized-user export as a frozen detached copy', () => {
    const source = material();
    const validated = validateGwsSessionMaterial(source);
    source.refresh_token = 'replaced';
    expect(validated.refresh_token).toBe('synthetic-refresh-token');
    expect(Object.isFrozen(validated)).toBe(true);
    expect(validateGwsSessionMaterial(Object.assign(Object.create(null), material()))).toEqual(
      material()
    );
  });

  it.each([
    null,
    [],
    JSON.stringify(material()),
    { ...material(), type: 'service_account' },
    { ...material(), token_uri: 'https://attacker.invalid' },
    { ...material(), credentials_enc: 'opaque-encrypted-material' },
    { ...material(), HOME: '/operator/home' },
    { ...material(), refresh_token: '' },
    { ...material(), refresh_token: '***' },
    { ...material(), refresh_token: 'abcd...wxyz' },
    { ...material(), client_secret: 'secret\nvalue' },
    { ...material(), client_secret: 'secret\0value' },
    { ...material(), client_secret: 'secret value' },
    { ...material(), client_secret: '秘密' },
    { ...material(), client_id: 'x'.repeat(GWS_SESSION_MATERIAL_LIMITS.clientIdBytes + 1) },
    { ...material(), refresh_token: 'x'.repeat(GWS_SESSION_MATERIAL_LIMITS.secretBytes + 1) },
    Object.assign(Object.create({ inherited: true }), material()),
    { ...material(), [Symbol('secret')]: 'hidden' },
  ])('rejects unsupported shapes without echoing material (%#)', (input) => {
    expect(() => validateGwsSessionMaterial(input)).toThrow(
      '[GWS_SESSION_MATERIAL_INVALID] Unsupported session material'
    );
  });

  it('never invokes an accessor or exposes a proxy exception', () => {
    const getter = vi.fn(() => 'sensitive-getter-result');
    const input = Object.defineProperty(material(), 'refresh_token', { get: getter });
    expect(() => validateGwsSessionMaterial(input)).toThrow('Unsupported session material');
    expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('sensitive-proxy-error');
        },
      }
    );
    expect(() => validateGwsSessionMaterial(proxy)).toThrow(
      '[GWS_SESSION_MATERIAL_INVALID] Unsupported session material'
    );
  });
});

describe('GWS inactive registration preflight', () => {
  it('always reports missing activation and runtime wiring without secret/target output', () => {
    const result = preflightGwsSessionRegistration(target());
    expect(result).toMatchObject({
      registrationAvailable: false,
      runtimeAvailable: false,
      reason: 'activation_not_implemented',
    });
    expect(result.requiredCapabilities).toContain('committed-approval-revalidation');
    expect(result.requiredCapabilities).toContain('isolated-home-lifetime-and-cleanup');
    expect(JSON.stringify(result)).not.toContain('acme');
    expect(Object.isFrozen(result.requiredCapabilities)).toBe(true);
    expect(
      preflightGwsSessionRegistration({
        ...target(),
        expectedGeneration: '12345678-1234-4123-8123-123456789012',
      }).runtimeAvailable
    ).toBe(false);
  });

  it.each([
    { ownerKind: 'person', ownerRef: 'user:owner' },
    { ownerKind: 'operator' },
    { ownerRef: 'other-tenant' },
    { tenantSlug: '' },
    { tenantSlug: '../acme' },
    { serviceId: 'gmail' },
    { authMode: 'secret-guard' },
    { expectedGeneration: 'stale' },
    { expectedGeneration: undefined },
    { activationReady: true },
    { material: material() },
  ])('rejects incompatible targets and caller readiness claims (%#)', (overrides) => {
    expect(() => preflightGwsSessionRegistration({ ...target(), ...overrides } as never)).toThrow(
      '[GWS_SESSION_REGISTRATION_DENIED] Explicit organization session required'
    );
  });

  it('does not evaluate target accessors', () => {
    const getter = vi.fn(() => 'acme');
    const input = Object.defineProperty(target(), 'tenantSlug', { get: getter });
    expect(() => preflightGwsSessionRegistration(input)).toThrow('Explicit organization session');
    expect(getter).not.toHaveBeenCalled();
  });
});
