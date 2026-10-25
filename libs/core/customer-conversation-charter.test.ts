import { createHash } from 'node:crypto';
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

  it('a sent message names the approval that authorized it (none when none was needed)', async () => {
    charterFor.mockReturnValue(undefined);
    gate.mockReturnValueOnce({
      allowed: true,
      status: 'approved',
      requestId: 'apr-granted',
      message: 'Approved by user:boss',
    });
    const approved = await sendToCustomer(input('Hello'));
    expect(approved).toEqual({ sent: true, status: 'sent', approvalRequestId: 'apr-granted' });
    const unattended = await sendToCustomer(input('Hello'));
    expect(unattended).toEqual({ sent: true, status: 'sent' });
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
    // Dotted words chat bridges do not auto-link are ordinary titles.
    for (const title of ['Node.js migration', 'v2.0 release', 'next.config tweaks', 'e.g. scope']) {
      expect(
        renderCustomerRoutineTemplate({ ...base, params: { title, date: '2026-10-30' } })
      ).toBeTypeOf('string');
    }
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
      { title: 'visit evil.com now', date: '2026-10-30' },
      { title: 'see acme.co.jp/path', date: '2026-10-30' },
      { title: 'ＡＣＭＥ．ＣＯＭ', date: '2026-10-30' },
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

  it('never copies the message into the approval request; the payload binds body and channel', async () => {
    charterFor.mockReturnValue(undefined);
    const body = 'Confidential pricing: 1,234,000 JPY, see https://evil.example.net/x';
    await sendToCustomer({
      ...input(body),
      binding: {
        tenantSlug: 'acme',
        binding: { surface: 'email', channel_id: 'cto@customer.example' },
      },
    } as never);
    const params = gate.mock.calls[0][0];
    const draftText = JSON.stringify(params.draft);
    expect(draftText).not.toContain('1,234,000');
    expect(draftText).not.toContain('evil.example.net');
    expect(draftText).not.toContain('cto@customer.example');
    expect(params.payload).toEqual({
      body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      surface: 'email',
      channel_id: 'cto@customer.example',
    });
    // A floor violation is flagged by count only; no source → the approver is told so.
    expect(params.draft?.title).toBe('⚠ Reply');
    expect(params.draft?.summary).toMatch(/^⚠ .*: 1 /u);
    expect(params.draft?.summary).toContain(String(params.payload?.body_sha256));
    expect(params.draft?.summary).not.toContain('customer-channel outbound');
    // Another body is another payload: an approval never covers edited text.
    await sendToCustomer(input(`${body}!`));
    expect(gate.mock.calls[1][0].payload?.body_sha256).not.toBe(params.payload?.body_sha256);
  });

  it('keeps an ids-only caller summary and still binds the body', async () => {
    charterFor.mockReturnValue(undefined);
    await sendToCustomer({ ...input('Hello there'), approvalSummary: 'Reminder r-1' });
    expect(gate.mock.calls[0][0].draft?.summary).toBe('Reminder r-1');
    expect(gate.mock.calls[0][0].payload).toMatchObject({
      body_sha256: createHash('sha256').update('Hello there', 'utf8').digest('hex'),
    });
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
