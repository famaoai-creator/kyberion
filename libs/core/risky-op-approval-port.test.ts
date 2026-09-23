import { describe, expect, it } from 'vitest';
import {
  overrideRiskyApprovalHandler,
  requireRiskyApproval,
  registerRiskyApprovalHandler,
} from './risky-op-approval-port.js';

describe('risky-op-approval-port', () => {
  it('rejects replacement of the canonical approval handler', () => {
    const first = () => ({ allowed: false, status: 'pending' as const });
    const second = () => ({ allowed: true, status: 'approved' as const });

    const dispose = registerRiskyApprovalHandler(first);

    expect(() => registerRiskyApprovalHandler(second)).toThrow(
      '[RISKY_APPROVAL_HANDLER_ALREADY_REGISTERED]'
    );
    expect(requireRiskyApproval({} as never)).toEqual({ allowed: false, status: 'pending' });
    dispose();
    expect(requireRiskyApproval({} as never)).toEqual({
      allowed: false,
      status: 'pending',
      message: 'Approval gate is not registered',
    });
  });

  it('consults a scoped override first and restores the canonical handler on dispose', () => {
    const canonical = () => ({ allowed: false, status: 'pending' as const });
    const disposeCanonical = registerRiskyApprovalHandler(canonical);
    const disposeOverride = overrideRiskyApprovalHandler(() => ({
      allowed: true,
      status: 'approved' as const,
    }));

    expect(requireRiskyApproval({} as never)).toEqual({ allowed: true, status: 'approved' });
    expect(() => overrideRiskyApprovalHandler(canonical)).toThrow(/risky-approval-override/);
    disposeOverride();
    expect(requireRiskyApproval({} as never)).toEqual({ allowed: false, status: 'pending' });
    disposeCanonical();
  });
});
