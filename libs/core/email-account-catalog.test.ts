import { afterEach, describe, expect, it } from 'vitest';
import {
  listEmailAccountProviders,
  registerEmailAccountProvider,
  type EmailAccountDescriptor,
} from './email-account-catalog.js';

describe('email-account-catalog', () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('registers a named account provider reversibly', () => {
    const descriptor: EmailAccountDescriptor = {
      id: `test-account-${process.pid}`,
      display_name: 'Test Account',
      status: 'needs_setup',
      selectable: true,
      reason: 'test',
      capabilities: ['list'],
    };
    dispose = registerEmailAccountProvider(descriptor, {
      provenance: 'generated',
      source: 'email-account-catalog.test.ts',
    });

    expect(listEmailAccountProviders()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: descriptor.id })])
    );
    expect(() => registerEmailAccountProvider(descriptor)).toThrow(/already registered/);

    dispose();
    dispose = undefined;
    expect(listEmailAccountProviders().some((entry) => entry.id === descriptor.id)).toBe(false);
  });
});
