import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./governance/approval-gate.js', () => ({ enforceApprovalGate: vi.fn() }));
vi.mock('./governance/charter-call-site.js', () => ({
  charterInputForCustomerOutbound: vi.fn(),
}));
vi.mock('./egress-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./egress-policy.js')>()),
  loadEgressPolicy: vi.fn(() => ({
    tenant_allowed_domains: { acme: ['example.com'] },
    link_allowed_domains: ['example.com'],
  })),
}));

import { sendToCustomer, type SendToCustomerInput } from './customer-conversation.js';
import { enforceApprovalGate } from './governance/approval-gate.js';
import { charterInputForCustomerOutbound } from './governance/charter-call-site.js';

const gate = vi.mocked(enforceApprovalGate);
const charterFor = vi.mocked(charterInputForCustomerOutbound);
const CHARTER = {
  scope: { kind: 'organization', tenant_slug: 'acme' },
  action: { action_class: 'send_message_external' },
} as never;

const input = (body: string): SendToCustomerInput =>
  ({
    binding: { tenantSlug: 'acme', binding: { surface: 'slack' } },
    title: 'Reply',
    body,
    correlationId: 'c-1',
    deliver: vi.fn(async () => undefined),
  }) as never;

describe('sendToCustomer × accountability charter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.mockReturnValue({ allowed: true, status: 'not_required', message: 'ok' });
  });

  it('hands the gate the tenant charter for a clean message', async () => {
    charterFor.mockReturnValue(CHARTER);
    const r = await sendToCustomer(input('Thanks, see https://example.com/help'));
    expect(charterFor).toHaveBeenCalledWith({ tenantSlug: 'acme' });
    expect(gate.mock.calls[0][0]).toMatchObject({ charter: CHARTER });
    expect(r.status).toBe('sent');
  });

  it('never offers a charter for a message that breaches the audience egress floor', async () => {
    charterFor.mockReturnValue(CHARTER);
    await sendToCustomer(input('Open https://evil.example.net/x'));
    expect(charterFor).not.toHaveBeenCalled();
    expect(gate.mock.calls[0][0]).not.toHaveProperty('charter');
  });

  it('keeps the legacy gate when the tenant has no charter in force', async () => {
    charterFor.mockReturnValue(undefined);
    await sendToCustomer(input('Hello'));
    expect(gate.mock.calls[0][0]).not.toHaveProperty('charter');
  });
});
