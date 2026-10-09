/**
 * Test support for approval separation of duties. Tests switch the setting
 * through a customer overlay of the real `approval-policy.json`, the way an
 * operator enables it. This module has no imports so it can be loaded from a
 * `vi.mock('…/customer-resolver.js')` factory without touching the module
 * being mocked:
 *
 *   vi.mock('../customer-resolver.js', async (importOriginal) => {
 *     const actual = await importOriginal<typeof import('../customer-resolver.js')>();
 *     const { customerRootWithSodOverlay } = await import('../governance/__tests__/sod-overlay-state.js');
 *     return { ...actual, customerRoot: customerRootWithSodOverlay(actual.customerRoot) };
 *   });
 */
export const sodOverlay: { path: string | null } = { path: null };

export function customerRootWithSodOverlay(
  original: (...args: never[]) => string | null
): (subPath?: string, ...rest: unknown[]) => string | null {
  return (subPath = '', ...rest) =>
    subPath === 'policy/approval-policy.json' && sodOverlay.path
      ? sodOverlay.path
      : (original as unknown as (...args: unknown[]) => string | null)(subPath, ...rest);
}
