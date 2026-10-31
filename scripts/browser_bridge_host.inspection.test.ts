import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { auditChain } from '@agent/core/governance/audit-chain';
import { safeExistsSync, safeReaddir, safeRmSync } from '@agent/core/secure-io';
import { resolveStorageFloor } from '@agent/core/storage-layout';
import {
  INSPECTION_HANDOFF_DOMAIN,
  InspectionHandoffError,
  awaitInspectionTicket,
  closeInspectionTicket,
  openInspectionTicket,
  sanitizeInspectionPayload,
  type InspectionHandoffScope,
  type InspectionHandoffTicket,
} from './lib/browser-inspection-handoff.js';

vi.mock('@agent/core/organization/tenant-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTenant: vi.fn((slug: string) => {
    if (slug !== 'acme') throw new Error(`no profile for ${slug}`);
    return { profile: { tenant_slug: slug } };
  }),
}));

let handle: typeof import('./browser_bridge_host.js').handle;
/** Loose view of a host reply for assertions. */
interface Reply {
  ok: boolean;
  code?: string;
  ticket_id?: string;
  [key: string]: unknown;
}
const opened: InspectionHandoffTicket[] = [];

beforeAll(async () => {
  ({ handle } = await import('./browser_bridge_host.js'));
}, 60_000);

const asConcierge = <T>(fn: () => T): T =>
  withExecutionContext('sovereign_concierge', fn, 'sovereign');

function open(scope: InspectionHandoffScope, ttlMs = 60_000, now?: Date) {
  const ticket = openInspectionTicket(scope, { ttlMs, ...(now ? { now } : {}) });
  opened.push(ticket);
  return ticket;
}

afterEach(() => {
  for (const ticket of opened.splice(0)) closeInspectionTicket(ticket);
  // Prune the domain directories this suite may have created, only while empty.
  asConcierge(() => {
    for (const scope of [
      { tier: 'personal' },
      { tier: 'confidential', tenant_slug: 'acme' },
    ] as const) {
      const dir = resolveStorageFloor(
        'staging',
        {
          kind: 'tier',
          tier: scope.tier,
          tenant: 'tenant_slug' in scope ? scope.tenant_slug : undefined,
        },
        INSPECTION_HANDOFF_DOMAIN
      );
      if (safeExistsSync(dir) && safeReaddir(dir).length === 0) {
        safeRmSync(dir, { recursive: true, force: true });
      }
    }
  });
  vi.restoreAllMocks();
});

function inspection(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/login?next=/home&token=abc#top',
    origin: 'https://example.com',
    title: 'Login for jane@example.com',
    headings: [{ level: 'h1', text: 'Sign in' }],
    inputs: [
      { tag: 'input', type: 'email', name: 'email', value: 'jane@example.com', required: true },
      { tag: 'script', name: 'x' },
    ],
    buttons: [{ text: 'Log in', id: 'submit' }],
    links: [
      { text: 'Help', href: 'https://example.com/help?session=1' },
      { text: 'Bad', href: 'javascript:alert(1)' },
    ],
    textExcerpt: 'Contact jane@example.com',
    ...overrides,
  };
}

describe('sanitizeInspectionPayload', () => {
  it('drops input values, strips query strings, redacts and filters unknown tags', () => {
    const clean = sanitizeInspectionPayload(inspection());
    expect(clean.url).toBe('https://example.com/login');
    expect(clean.origin).toBe('https://example.com');
    expect(clean.title).not.toContain('jane@example.com');
    expect(clean.textExcerpt).not.toContain('jane@example.com');
    expect(clean.inputs).toEqual([{ tag: 'input', type: 'email', name: 'email', required: true }]);
    expect(clean.links).toEqual([{ text: 'Help', href: 'https://example.com/help' }]);
    expect(clean.truncated).toBe(false);
  });

  it('bounds lists and flags truncation', () => {
    const clean = sanitizeInspectionPayload(
      inspection({ buttons: Array.from({ length: 100 }, (_, i) => ({ text: `b${i}` })) })
    );
    expect(clean.buttons).toHaveLength(40);
    expect(clean.truncated).toBe(true);
  });

  it('rejects non-http pages, origin mismatch and oversize payloads', () => {
    expect(() => sanitizeInspectionPayload(inspection({ url: 'file:///etc/passwd' }))).toThrow(
      InspectionHandoffError
    );
    expect(() => sanitizeInspectionPayload(inspection({ origin: 'https://evil.test' }))).toThrow(
      /origin does not match/
    );
    expect(() =>
      sanitizeInspectionPayload(inspection({ textExcerpt: 'x'.repeat(70 * 1024) }))
    ).toThrow(/cap is/);
    expect(() => sanitizeInspectionPayload([])).toThrow(/must be an object/);
  });
});

describe('submit_inspection (native host)', () => {
  it('refuses and audits when no CLI is waiting', async () => {
    const audit = vi.spyOn(auditChain, 'record');
    const reply = (await handle({ type: 'submit_inspection', inspection: inspection() })) as Reply;
    expect(reply).toMatchObject({ ok: false, code: 'no_waiting_cli' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'browser_bridge_submit_inspection', result: 'denied' })
    );
  });

  it('rejects an invalid payload without touching a waiting ticket', async () => {
    const ticket = open({ tier: 'personal' });
    const reply = (await handle({
      type: 'submit_inspection',
      inspection: inspection({ url: 'chrome://settings' }),
    })) as Reply;
    expect(reply).toMatchObject({ ok: false, code: 'invalid_input' });
    await expect(
      awaitInspectionTicket(
        { ...ticket, expires_at: new Date(Date.now() + 60).toISOString() },
        { pollMs: 50 }
      )
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('hands a sanitized inspection to the waiting CLI ticket, audited with its scope', async () => {
    const ticket = open({ tier: 'confidential', tenant_slug: 'acme' });
    const audit = vi.spyOn(auditChain, 'record');
    const reply = (await handle({ type: 'submit_inspection', inspection: inspection() })) as Reply;
    expect(reply).toMatchObject({
      ok: true,
      ticket_id: ticket.ticket_id,
      scope: { tier: 'confidential', tenant_slug: 'acme' },
      origin: 'https://example.com',
      counts: { headings: 1, inputs: 1, buttons: 1, links: 1 },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'browser_bridge_submit_inspection',
        result: 'completed',
        metadata: expect.objectContaining({ tier: 'confidential', tenant_slug: 'acme' }),
      })
    );
    const received = await awaitInspectionTicket(ticket, { pollMs: 50 });
    expect(received.url).toBe('https://example.com/login');
    expect(received.inputs[0]).not.toHaveProperty('value');
    // The ticket is consumed: a second submission finds nobody waiting.
    const again = (await handle({ type: 'submit_inspection', inspection: inspection() })) as Reply;
    expect(again.code).toBe('no_waiting_cli');
  });

  it('prefers the newest waiting ticket and sweeps expired ones', async () => {
    const stale = open({ tier: 'personal' }, 1_000, new Date(Date.now() - 10_000));
    const older = open({ tier: 'personal' }, 60_000, new Date(Date.now() - 1_000));
    const newer = open({ tier: 'personal' });
    const reply = (await handle({ type: 'submit_inspection', inspection: inspection() })) as Reply;
    expect(reply.ticket_id).toBe(newer.ticket_id);
    const staleFile = path.join(
      resolveStorageFloor('staging', { kind: 'tier', tier: 'personal' }, INSPECTION_HANDOFF_DOMAIN),
      `${stale.ticket_id}.json`
    );
    expect(asConcierge(() => safeExistsSync(staleFile))).toBe(false);
    const olderFile = staleFile.replace(stale.ticket_id, older.ticket_id);
    expect(asConcierge(() => safeExistsSync(olderFile))).toBe(true);
  });
});

describe('inspect_browser_page --mode extension (end to end through the host)', () => {
  it('receives the inspection the extension submits via the native host', async () => {
    const { main } = await import('./inspect_browser_page.js');
    const dir = resolveStorageFloor(
      'staging',
      { kind: 'tier', tier: 'personal' },
      INSPECTION_HANDOFF_DOMAIN
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const print = vi.fn();
    const pending = main(['--mode', 'extension', '--timeout', '10000', '--json'], print, {
      nodeVersion: 'v24.1.0',
    });
    // Once the CLI's ticket exists, submit as the extension would.
    let reply: Reply = { ok: false };
    await vi.waitFor(
      async () => {
        reply = (await handle({ type: 'submit_inspection', inspection: inspection() })) as Reply;
        expect(reply.ok).toBe(true);
      },
      { timeout: 5_000, interval: 50 }
    );
    const report = await pending;
    expect(report).toMatchObject({ mode: 'extension', url: 'https://example.com/login' });
    expect(print).toHaveBeenCalledWith(expect.stringContaining('"mode": "extension"'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('com.kyberion.browser_bridge'));
    const left = asConcierge(() => (safeExistsSync(dir) ? safeReaddir(dir) : []));
    expect(left).not.toContain(`${reply.ticket_id}.json`);
  });
});
