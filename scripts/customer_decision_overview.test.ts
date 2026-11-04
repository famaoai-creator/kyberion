import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runOverview: vi.fn(() => ({ ok: true })) }));
vi.mock('./customer-decision/overview.js', () => ({ runOverview: mocks.runOverview }));

import { runCustomerDecisionOverview } from './customer_decision_overview.js';

describe('customer_decision_overview (read-only facade entry)', () => {
  it('runs the overview verb with the parsed options', () => {
    const result = runCustomerDecisionOverview(
      ['overview', '--tenant', 'acme', '--summary'],
      '2026-11-04T00:00:00.000Z'
    );
    expect(result).toEqual({ ok: true });
    const [opts, flags, now] = mocks.runOverview.mock.calls[0] as unknown as [
      Record<string, string>,
      Set<string>,
      string,
    ];
    expect(opts.tenant).toBe('acme');
    expect(flags.has('summary')).toBe(true);
    expect(now).toBe('2026-11-04T00:00:00.000Z');
  });

  it.each(['respond', 'draft', 'learning', 'confirm', 'send'])(
    'refuses the %s verb, which belongs to the writer CLI',
    (verb) => {
      expect(() => runCustomerDecisionOverview([verb, '--tenant', 'acme'])).toThrow(
        /only the read-only 'overview' verb/
      );
    }
  );
});
