import { describe, it, expect } from 'vitest';
import {
  activeCustomer,
  customerRoot,
  overlayCandidates,
  InvalidCustomerSlugError,
  __test__,
} from './customer-resolver.js';

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
      expect(() =>
        activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'ACME' }),
      ).toThrow(InvalidCustomerSlugError);
    });

    it('throws on path traversal attempts', () => {
      expect(() =>
        activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: '../etc' }),
      ).toThrow(InvalidCustomerSlugError);
      expect(() =>
        activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'a/b' }),
      ).toThrow(InvalidCustomerSlugError);
    });

    it('throws on leading hyphen', () => {
      expect(() =>
        activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: '-bad' }),
      ).toThrow(InvalidCustomerSlugError);
    });

    it('throws on dots, spaces, special chars', () => {
      expect(() =>
        activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'a.b' }),
      ).toThrow(InvalidCustomerSlugError);
      expect(() =>
        activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'a b' }),
      ).toThrow(InvalidCustomerSlugError);
      expect(() =>
        activeCustomer({ [__test__.CUSTOMER_ENV_VAR]: 'a$b' }),
      ).toThrow(InvalidCustomerSlugError);
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
});
