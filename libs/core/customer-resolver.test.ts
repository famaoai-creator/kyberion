import { afterEach, describe, it, expect, vi } from 'vitest';

const existingPaths = new Set<string>();
vi.mock('./fs-primitives.js', () => ({
  rawExistsSync: (p: string) => existingPaths.has(p),
}));

const {
  activeCustomer,
  customerRoot,
  overlayCandidates,
  resolveOverlay,
  InvalidCustomerSlugError,
  __test__,
} = await import('./customer-resolver.js');

describe('customer-resolver', () => {
  describe('activeCustomer', () => {
    it('returns null when env var is unset', () => {
      expect(activeCustomer({})).toBeNull();
    });

    it('returns null when env var is empty string', () => {
      expect(activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: '' })).toBeNull();
    });

    it('returns null when env var is whitespace', () => {
      expect(activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: '   ' })).toBeNull();
    });

    it('returns the slug when valid', () => {
      expect(activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'acme-corp' })).toBe('acme-corp');
      expect(activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'client_a' })).toBe('client_a');
      expect(activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'a' })).toBe('a');
      expect(activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: '1demo' })).toBe('1demo');
    });

    it('trims surrounding whitespace', () => {
      expect(activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: '  acme  ' })).toBe('acme');
    });

    it('throws on uppercase', () => {
      expect(() => activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'ACME' })).toThrow(
        InvalidCustomerSlugError
      );
    });

    it('throws on path traversal attempts', () => {
      expect(() => activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: '../etc' })).toThrow(
        InvalidCustomerSlugError
      );
      expect(() => activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'a/b' })).toThrow(
        InvalidCustomerSlugError
      );
    });

    it('throws on leading hyphen', () => {
      expect(() => activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: '-bad' })).toThrow(
        InvalidCustomerSlugError
      );
    });

    it('throws on dots, spaces, special chars', () => {
      expect(() => activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'a.b' })).toThrow(
        InvalidCustomerSlugError
      );
      expect(() => activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'a b' })).toThrow(
        InvalidCustomerSlugError
      );
      expect(() => activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'a$b' })).toThrow(
        InvalidCustomerSlugError
      );
    });
  });

  describe('customerRoot', () => {
    it('returns null when no slug active', () => {
      expect(customerRoot('', {})).toBeNull();
    });

    it('returns absolute path under customer/{slug} when active', () => {
      const root = customerRoot('', { [__test__.CUSTOMER_ENV_VAR]: 'acme' });
      expect(root).not.toBeNull();
      expect(root!.endsWith('/customer/acme')).toBe(true);
    });

    it('joins subPath when provided', () => {
      const p = customerRoot('identity.json', { [__test__.CUSTOMER_ENV_VAR]: 'acme' });
      expect(p!.endsWith('/customer/acme/identity.json')).toBe(true);
    });
  });

  describe('overlayCandidates', () => {
    it('returns both overlay null and base path when no slug active', () => {
      const { overlay, base } = overlayCandidates('connections/slack.json', {});
      expect(overlay).toBeNull();
      expect(base.endsWith('/knowledge/personal/connections/slack.json')).toBe(true);
    });

    it('returns both candidates when slug active', () => {
      const { overlay, base } = overlayCandidates('connections/slack.json', {
        [__test__.CUSTOMER_ENV_VAR]: 'acme',
      });
      expect(overlay!.endsWith('/customer/acme/connections/slack.json')).toBe(true);
      expect(base.endsWith('/knowledge/personal/connections/slack.json')).toBe(true);
    });
  });

  describe('resolveOverlay', () => {
    afterEach(() => {
      existingPaths.clear();
    });

    it('falls back to knowledge/personal when no customer slug is active', () => {
      const p = resolveOverlay('my-identity.json', {});
      expect(p.endsWith('/knowledge/personal/my-identity.json')).toBe(true);
    });

    it('prefers the customer overlay when it exists, even if personal also exists', () => {
      const env = { [__test__.CUSTOMER_ENV_VAR]: 'acme' };
      const overlayPath = customerRoot('my-identity.json', env)!;
      const personalPath = overlayCandidates('my-identity.json', env).base;
      existingPaths.add(overlayPath);
      existingPaths.add(personalPath);

      expect(resolveOverlay('my-identity.json', env)).toBe(overlayPath);
    });

    it('falls back to personal when a slug is active but the overlay file is absent', () => {
      const env = { [__test__.CUSTOMER_ENV_VAR]: 'acme' };
      const personalPath = overlayCandidates('my-identity.json', env).base;
      existingPaths.add(personalPath);

      expect(resolveOverlay('my-identity.json', env)).toBe(personalPath);
    });

    it('returns the customer path (for writes) when a slug is active but neither file exists', () => {
      const env = { [__test__.CUSTOMER_ENV_VAR]: 'acme' };
      const overlayPath = customerRoot('my-identity.json', env)!;

      expect(resolveOverlay('my-identity.json', env)).toBe(overlayPath);
    });

    it('returns the personal path (for writes) when no slug is active and neither file exists', () => {
      const personalPath = overlayCandidates('my-identity.json', {}).base;

      expect(resolveOverlay('my-identity.json', {})).toBe(personalPath);
    });
  });
});
