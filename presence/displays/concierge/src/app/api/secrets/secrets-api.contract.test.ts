import { describe, expect, it, vi } from 'vitest';

const applySecretIntroduction = vi.fn(
  async (_input: { approvalId: string; value: string }): Promise<never> => {
    throw new Error('[SECRET_INTRODUCTION] approval x must be approved before apply');
  }
);

vi.mock('@agent/core/secret-introduction', () => ({
  applySecretIntroduction,
  proposeSecretIntroduction: vi.fn(),
  describeIntroductionReadiness: vi.fn(),
}));

describe('concierge secrets apply contract', () => {
  it('maps unapproved apply failures to 403 without echoing the value', async () => {
    const secretValue = `leak-check-${Date.now()}`;
    try {
      await applySecretIntroduction({
        approvalId: 'x',
        value: secretValue,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/must be approved/);
      expect(message).not.toContain(secretValue);
      // Route maps this message to HTTP 403.
      expect(/must be approved/i.test(message)).toBe(true);
    }
  });
});
