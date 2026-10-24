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
import { renderCustomerRoutineTemplate } from './customer-outbound-templates.js';

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
    expect(charterFor).toHaveBeenCalledWith({
      tenantSlug: 'acme',
      categories: ['unknown'],
      attachmentCount: 0,
    });
    expect(gate.mock.calls[0][0]).toMatchObject({ charter: CHARTER });
    expect(r.status).toBe('sent');
  });

  it('classifies an exact routine greeting separately from arbitrary customer content', async () => {
    charterFor.mockReturnValue(CHARTER);
    await sendToCustomer(input('こんにちは。'));
    expect(charterFor).toHaveBeenCalledWith({
      tenantSlug: 'acme',
      categories: ['routine_business'],
      attachmentCount: 0,
    });
    await sendToCustomer(input('Please find our quote attached'));
    expect(charterFor).toHaveBeenLastCalledWith({
      tenantSlug: 'acme',
      categories: ['unknown'],
      attachmentCount: 0,
    });
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

  it('classifies the exact rendering of a registered template as routine, and nothing else (CD-11)', async () => {
    charterFor.mockReturnValue(CHARTER);
    const template = {
      id: 'customer_decision.reminder.before_due',
      params: { title: 'Requirements', date: '2026-10-30' },
      locale: 'ja' as const,
    };
    const body = renderCustomerRoutineTemplate(template) as string;
    expect(body).toContain('Requirements');
    expect(body).toContain('2026-10-30');
    const categories = () => charterFor.mock.calls.at(-1)?.[0].categories;
    await sendToCustomer({ ...input(body), template });
    expect(categories()).toEqual(['routine_business']);
    // An edited text, another locale, a changed parameter or an unknown id is not routine.
    await sendToCustomer({ ...input(`${body} Call us!`), template });
    expect(categories()).toEqual(['unknown']);
    await sendToCustomer({ ...input(body), template: { ...template, locale: 'en' } });
    expect(categories()).toEqual(['unknown']);
    await sendToCustomer({
      ...input(body),
      template: { ...template, params: { ...template.params, date: '2026-10-31' } },
    });
    expect(categories()).toEqual(['unknown']);
    await sendToCustomer({ ...input(body), template: { ...template, id: 'nope' } });
    expect(categories()).toEqual(['unknown']);
    await sendToCustomer(input(body));
    expect(categories()).toEqual(['unknown']);
  });

  it('refuses template parameters that could carry free content (CD-11)', () => {
    const base = { id: 'customer_decision.reminder.due', locale: 'en' as const };
    expect(
      renderCustomerRoutineTemplate({ ...base, params: { title: 'T', date: '2026-10-30' } })
    ).toBeTypeOf('string');
    // A long (≤ 300, the agenda title limit), punctuated, Japanese title is fine.
    expect(
      renderCustomerRoutineTemplate({
        ...base,
        params: { title: `要件の確認（第2.0版）— ${'あ'.repeat(250)}`, date: '2026-10-30' },
      })
    ).toBeTypeOf('string');
    // The override notice carries the closing time and zone; an unknown zone is refused.
    const closing = { id: 'customer_decision.reminder.override_closing', locale: 'en' as const };
    expect(
      renderCustomerRoutineTemplate({
        ...closing,
        params: { title: 'T', date: '2026-11-05', time: '09:00', zone: 'JST' },
      })
    ).toBeTypeOf('string');
    expect(
      renderCustomerRoutineTemplate({
        ...closing,
        params: { title: 'T', date: '2026-11-05', time: '09:00', zone: 'PST' },
      })
    ).toBeNull();
    for (const params of [
      { title: 'see https://evil.example', date: '2026-10-30' },
      { title: 'www.evil.example', date: '2026-10-30' },
      { title: 'two\nlines', date: '2026-10-30' },
      { title: 'T', date: 'tomorrow' },
      { title: 'T' },
      { title: 'T', date: '2026-10-30', extra: 'x' },
      { title: 'x'.repeat(301), date: '2026-10-30' },
      // Bidi / zero-width / line and paragraph separators and NEL.
      { title: 'abc\u202Edef', date: '2026-10-30' },
      { title: 'a\u200Bb', date: '2026-10-30' },
      { title: 'a\u2028b', date: '2026-10-30' },
      { title: 'a\u0085b', date: '2026-10-30' },
      // Bare domains and fullwidth link syntax.
      { title: 'visit evil.example now', date: '2026-10-30' },
      { title: 'https：／／evil', date: '2026-10-30' },
      // Mention / broadcast syntax.
      { title: '<!channel> hi', date: '2026-10-30' },
      { title: '<@U123> hi', date: '2026-10-30' },
      { title: 'hi @everyone', date: '2026-10-30' },
      { title: 'hi @here', date: '2026-10-30' },
    ]) {
      expect(renderCustomerRoutineTemplate({ ...base, params })).toBeNull();
    }
  });

  it('passes enqueueRequest and the request scope to the gate only when given, and reports the request status (CD-11)', async () => {
    charterFor.mockReturnValue(undefined);
    await sendToCustomer(input('Hello'));
    expect(gate.mock.calls[0][0]).not.toHaveProperty('enqueueRequest');
    expect(gate.mock.calls[0][0]).not.toHaveProperty('requestScope');
    gate.mockReturnValueOnce({
      allowed: false,
      status: 'pending',
      requestId: 'apr-9',
      requestStatus: 'rejected',
      message: 'rejected',
    });
    const scope = {
      scope_kind: 'tenant' as const,
      tier: 'confidential' as const,
      tenant_slug: 'acme',
    };
    const held = await sendToCustomer({
      ...input('Hello'),
      enqueueRequest: true,
      requestScope: scope,
    });
    expect(gate.mock.calls[1][0]).toMatchObject({ enqueueRequest: true, requestScope: scope });
    expect(held).toMatchObject({
      status: 'approval_pending',
      approvalRequestId: 'apr-9',
      approvalRequestStatus: 'rejected',
    });
  });
});
