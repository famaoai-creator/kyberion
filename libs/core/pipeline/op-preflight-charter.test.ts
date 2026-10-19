import { afterEach, describe, expect, it } from 'vitest';
import { ensureDefaultOpPreflight } from './op-preflight-defaults.js';
import { resetOpPreflight, runOpPreflight } from './op-preflight.js';

afterEach(() => resetOpPreflight());

describe('charter decision fact admission', () => {
  const call = (params: Record<string, unknown>, approvalGranted = false) => {
    ensureDefaultOpPreflight();
    return runOpPreflight({
      op: 'approval:evaluate_decision_rights',
      source: 'actuator',
      params,
      approvalGranted,
    });
  };

  it.each([NaN, Infinity, -1, '100', null])(
    'denies malformed monetary facts even with human approval: %s',
    async (amount) => {
      const result = await call({ decision_type: 'vendor_invoice_payment', amount }, true);
      expect(result.decision).toBe('block');
      expect(result.reason).toContain('OP_CHARTER_FACTS_DENIED');
      expect(result.terminate).toBe(true);
    }
  );

  it('rejects inference-only facts for an external recipient action', async () => {
    const result = await call({
      decision_type: 'external_reply',
      information_flow: {
        purpose: 'customer_service',
        processor_id: 'local',
        categories: ['routine_business'],
      },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('recipient_class');
  });

  it('preserves missing facts for the existing human decision path without repairing them', async () => {
    const params = { decision_type: 'vendor_invoice_payment' };
    const result = await call(params);
    expect(result.decision).toBe('allow');
    expect(result.input).toEqual(params);
    expect(result.repaired_input).toBeUndefined();
  });

  it('admits valid facts without reserving a budget or authorizing the decision itself', async () => {
    const result = await call({
      decision_type: 'external_reply',
      recipients: 1,
      information_flow: {
        purpose: 'customer_service',
        recipient_class: 'bound_customer',
        categories: ['routine_business'],
      },
    });
    expect(result.decision).toBe('allow');
    expect(result.guard_ids).toContain('core:charter-facts');
  });

  it('leaves unrelated operations and unknown decision types to their own contracts', async () => {
    expect((await call({ decision_type: 'future_decision', amount: 'legacy' })).decision).toBe(
      'allow'
    );
    expect(
      (
        await runOpPreflight({
          op: 'service:read',
          source: 'actuator',
          params: { decision_type: 'external_reply', information_flow: null },
        })
      ).decision
    ).toBe('allow');
  });
});
