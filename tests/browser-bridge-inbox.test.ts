import { safeReadFile } from '@agent/core/secure-io';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Pure inbox / send helpers shared by the Side Panel and the service worker
// (tools/adf-replay-extension/bridge-inbox.js). They decide which controls an
// inbox card may show, so the "no approve button" and "observe_tab is never
// auto-answered" guarantees are pinned here.

type InboxModel = Record<string, any>;
let model: InboxModel;

const RID = 'BBR-12345678-1234-4234-8234-123456789abc';
const scrub = (value: unknown) =>
  String(value ?? '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[REDACTED:EMAIL_ADDRESS]');

function request(kind: string, payload: any, overrides: Record<string, unknown> = {}) {
  return {
    request_id: RID,
    request_kind: kind,
    created_at: '2026-10-31T00:00:00.000Z',
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    requested_by: { actor_id: 'agent-1' },
    scope: { tier: 'confidential', tenant_slug: 'acme' },
    payload,
    status: 'delivered',
    ...overrides,
  };
}

beforeAll(async () => {
  await import('../tools/adf-replay-extension/bridge-inbox.js');
  model = (globalThis as any).KyberionBridgeInbox;
});

describe('Browser Bridge inbox model', () => {
  it('offers respond / decline for observe and infer requests', () => {
    const observe = model.describeRequest(
      request('observe_tab', {
        purpose: '在庫を確認',
        mode: 'text',
        allowed_origins: ['https://shop.example'],
      })
    );
    expect(observe.controls).toEqual(['respond', 'decline']);
    expect(observe.lines.join('\n')).toContain('https://shop.example');
    expect(observe.scope).toBe('confidential / acme');
    expect(
      model.describeRequest(request('local_infer', { task: 'summarize', input: 'x' })).controls
    ).toEqual(['respond', 'decline']);
  });

  it('shows the approve command for approval_pending and never an approve control', () => {
    const view = model.describeRequest(
      request('notify', {
        level: 'approval_pending',
        title: '送信の承認',
        body: 'b',
        approval_request_id: 'APR-42',
      })
    );
    expect(view.command).toBe('pnpm kyberion approvals --approve APR-42');
    expect(view.controls).toEqual(['copy_command', 'dismiss']);
    expect(view.controls).not.toContain('respond');
    expect(view.controls).not.toContain('acknowledge');
    expect(view.levelLabel).toBe('承認待ち');

    const unsafe = model.describeRequest(
      request('notify', {
        level: 'approval_pending',
        title: 't',
        body: 'b',
        approval_request_id: 'APR-1; rm -rf /',
      })
    );
    expect(unsafe.command).toBeNull();
    expect(unsafe.controls).toEqual(['dismiss']);
  });

  it('acknowledges info / progress notices and spells out their level', () => {
    const progress = model.describeRequest(
      request('notify', {
        level: 'progress',
        title: 't',
        body: 'b',
        progress: { done: 2, total: 5 },
      })
    );
    expect(progress.controls).toEqual(['acknowledge']);
    expect(progress.levelLabel).toBe('進捗');
    expect(progress.lines).toContain('進捗: 2 / 5');
  });

  it('read-only approval summaries only ever offer copying the command', () => {
    const view = model.describeApproval({
      request_id: 'APR-9',
      title: 'Deploy',
      risk: 'high',
      approve_command: 'pnpm kyberion approvals --approve APR-9',
    });
    expect(view.controls).toEqual(['copy_command']);
    expect(view.riskLabel).toBe('高リスク');
  });

  it('auto-responds only to local_infer, and only when opted in', () => {
    const infer = request('local_infer', { task: 'summarize', input: 'x' });
    const observe = request('observe_tab', { purpose: 'p', mode: 'text' });
    expect(model.shouldAutoRespond(infer, false)).toBe(false);
    expect(model.shouldAutoRespond(infer, undefined)).toBe(false);
    expect(model.shouldAutoRespond(infer, true)).toBe(true);
    expect(model.shouldAutoRespond(observe, true)).toBe(false);
  });

  it('counts actionable items for the badge and treats past expiry as expired', () => {
    const items = [
      request('observe_tab', { purpose: 'p', mode: 'text' }),
      request('local_infer', { task: 'summarize', input: 'x' }),
      request('notify', {
        level: 'approval_pending',
        title: 't',
        body: 'b',
        approval_request_id: 'A',
      }),
      request('notify', { level: 'info', title: 't', body: 'b' }),
    ];
    expect(model.badgeCount(items)).toBe(3);
    expect(model.isExpired({ expires_at: new Date(Date.now() - 1).toISOString() })).toBe(true);
    expect(model.isExpired({ expires_at: 'not a date' })).toBe(true);
    expect(model.remainingLabel(new Date(Date.now() - 1).toISOString())).toBe('期限切れ');
  });

  it('caps and scrubs WebMCP tools to names, descriptions and input keys', () => {
    const raw = Array.from({ length: 70 }, (_, index) => ({
      name: `t${index}`,
      description: `mail a${index}@example.com`,
      input_keys: Array.from({ length: 40 }, (_, key) => `k${key}`),
      execute: () => 'never',
    }));
    const { tools, truncated } = model.sanitizeWebMcpTools(raw, scrub);
    expect(tools).toHaveLength(50);
    expect(truncated).toBe(true);
    expect(tools[0]).toEqual({
      name: 't0',
      description: 'mail [REDACTED:EMAIL_ADDRESS]',
      input_keys: Array.from({ length: 32 }, (_, key) => `k${key}`),
    });
    expect(Object.keys(tools[0])).not.toContain('execute');
  });
});

describe('Browser Bridge send form', () => {
  const base = {
    mode: 'knowledge',
    tier: 'personal',
    title: 'Example',
    urlOrigin: 'https://example.com/path?q=1',
    text: '本文',
    selectionOnly: true,
  };

  it('defaults to personal and sends only the origin', () => {
    const built = model.buildSendPagePayload({ ...base, tier: undefined });
    expect(built.ok).toBe(true);
    expect(built.payload).toEqual({
      type: 'send_page',
      mode: 'knowledge',
      tier: 'personal',
      title: 'Example',
      url_origin: 'https://example.com',
      text: '本文',
      selection_only: true,
    });
  });

  it('requires a tenant for confidential and an explicit confirmation for public', () => {
    expect(model.buildSendPagePayload({ ...base, tier: 'confidential' }).ok).toBe(false);
    expect(
      model.buildSendPagePayload({ ...base, tier: 'confidential', tenantSlug: 'Acme' }).payload
    ).toMatchObject({ tier: 'confidential', tenant_slug: 'acme' });
    expect(model.buildSendPagePayload({ ...base, tier: 'public' }).ok).toBe(false);
    expect(
      model.buildSendPagePayload({ ...base, tier: 'public', confirmPublic: true }).payload
    ).toMatchObject({ tier: 'public', confirm_public: true });
  });

  it('rejects empty, oversized and non-http(s) sends', () => {
    expect(model.buildSendPagePayload({ ...base, text: '  ' }).ok).toBe(false);
    expect(model.buildSendPagePayload({ ...base, text: 'x'.repeat(30_001) }).ok).toBe(false);
    expect(model.buildSendPagePayload({ ...base, urlOrigin: 'file:///etc/passwd' }).ok).toBe(false);
    expect(model.buildSendPagePayload({ ...base, note: 'x'.repeat(1_001) }).ok).toBe(false);
  });
});

describe('Browser Bridge side panel inbox wiring', () => {
  const source = String(
    safeReadFile(path.resolve(__dirname, '../tools/adf-replay-extension/sidepanel.js'), {
      encoding: 'utf8',
    })
  );

  it('auto-answers through the model gate and keeps Built-in AI in the panel', () => {
    expect(source).toMatch(/InboxModel\.shouldAutoRespond\(item, inbox\.localInferAuto === true\)/);
    expect(source).toContain('aiAdapter().runLocalTask(');
    // observe_tab is answered only from the click handler, flagged as a user action.
    const observeCalls = source.match(/userAction: true/g) || [];
    expect(observeCalls).toHaveLength(1);
  });

  it('opens a sidepanel port so the service worker can fast-poll', () => {
    expect(source).toContain("chrome.runtime.connect({ name: 'sidepanel' })");
  });
});
