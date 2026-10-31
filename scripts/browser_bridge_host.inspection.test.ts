import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { auditChain } from '@agent/core/governance/audit-chain';
import { safeExistsSync, safeReadFile, safeReaddir, safeRmSync } from '@agent/core/secure-io';
import { resolveStorageFloor } from '@agent/core/storage-layout';
import {
  INSPECTION_HANDOFF_DOMAIN,
  InspectionHandoffError,
  awaitInspectionTicket,
  closeInspectionTicket,
  openInspectionTicket,
  sanitizeInspectionPayload,
  submitInspectionToWaitingTicket,
  type OpenedInspectionTicket,
  type InspectionHandoffScope,
  type InspectionHandoffTicket,
} from './lib/browser-inspection-handoff.js';

/** When set, writing a `submitted` ticket fails (simulates a full disk after the audit). */
const writeFault = vi.hoisted(() => ({ failSubmitted: false }));
vi.mock('@agent/core/foundation/json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/foundation/json')>();
  return {
    ...actual,
    writeJson: (filePath: string, value: unknown, options?: never) => {
      if (writeFault.failSubmitted && (value as { status?: string })?.status === 'submitted') {
        throw new Error('ENOSPC: no space left on device');
      }
      return actual.writeJson(filePath, value, options);
    },
  };
});

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
const opened: OpenedInspectionTicket[] = [];

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

const submit = (ticketOrCode: { pairing_code: string } | string | undefined, overrides = {}) =>
  handle({
    type: 'submit_inspection',
    inspection: inspection(overrides),
    ...(ticketOrCode === undefined
      ? {}
      : {
          pairing_code: typeof ticketOrCode === 'string' ? ticketOrCode : ticketOrCode.pairing_code,
        }),
  }) as Promise<Reply>;

/** A well-formed code that differs from the ticket's. */
function otherCode(code: string): string {
  return (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
}

function ticketFile(ticket: InspectionHandoffTicket): string {
  return path.join(
    resolveStorageFloor(
      'staging',
      { kind: 'tier', tier: ticket.scope.tier, tenant: ticket.scope.tenant_slug },
      INSPECTION_HANDOFF_DOMAIN
    ),
    `${ticket.ticket_id}.json`
  );
}

function storedTicket(ticket: InspectionHandoffTicket): Record<string, unknown> {
  return asConcierge(() =>
    JSON.parse(String(safeReadFile(ticketFile(ticket), { encoding: 'utf8' })))
  );
}

describe('submit_inspection (native host)', () => {
  it('refuses and audits when no CLI is waiting', async () => {
    const audit = vi.spyOn(auditChain, 'record');
    const reply = await submit('ABCDEF');
    expect(reply).toMatchObject({ ok: false, code: 'no_waiting_cli' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'browser_bridge_submit_inspection', result: 'denied' })
    );
  });

  it('requires the pairing code and never falls back to "the newest ticket"', async () => {
    const ticket = open({ tier: 'personal' });
    expect(ticket.pairing_code).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);
    expect((await submit(undefined)).code).toBe('pairing_code_required');
    expect((await submit('12')).code).toBe('invalid_input');
    expect((await submit(otherCode(ticket.pairing_code))).code).toBe('pairing_mismatch');
    // The ticket on disk keeps only a digest of the code and is still waiting.
    const raw = String(asConcierge(() => safeReadFile(ticketFile(ticket), { encoding: 'utf8' })));
    expect(raw).not.toContain(`"${ticket.pairing_code}"`);
    expect(storedTicket(ticket).status).toBe('waiting');
  });

  it('rejects an invalid payload without touching the paired ticket', async () => {
    const ticket = open({ tier: 'personal' });
    const reply = await submit(ticket, { url: 'chrome://settings' });
    expect(reply).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(storedTicket(ticket).status).toBe('waiting');
  });

  it('hands a sanitized inspection to the paired ticket, audited with its scope', async () => {
    const ticket = open({ tier: 'confidential', tenant_slug: 'acme' });
    const audit = vi.spyOn(auditChain, 'record');
    // Lower-case with a separator is normalized.
    const typed =
      `${ticket.pairing_code.slice(0, 3)}-${ticket.pairing_code.slice(3)}`.toLowerCase();
    const reply = await submit(typed);
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
    // The ticket is consumed: the same code finds nobody waiting.
    expect((await submit(ticket)).code).toBe('no_waiting_cli');
  });

  it('keeps two waiting CLIs in different scopes apart: each code reaches only its own ticket', async () => {
    const acme = open({ tier: 'confidential', tenant_slug: 'acme' });
    const personal = open({ tier: 'personal' });
    const first = await submit(acme, { title: 'for acme' });
    expect(first).toMatchObject({ ok: true, ticket_id: acme.ticket_id });
    expect(storedTicket(personal).status).toBe('waiting');
    const second = await submit(personal, { title: 'for me' });
    expect(second).toMatchObject({
      ok: true,
      ticket_id: personal.ticket_id,
      scope: { tier: 'personal' },
    });
    expect((await awaitInspectionTicket(acme, { pollMs: 50 })).title).toBe('for acme');
    expect((await awaitInspectionTicket(personal, { pollMs: 50 })).title).toBe('for me');
  });

  it('enforces an --origin pin on the ticket', async () => {
    const ticket = openInspectionTicket(
      { tier: 'personal' },
      { ttlMs: 60_000, allowedOrigin: 'https://bank.example' }
    );
    opened.push(ticket);
    expect((await submit(ticket)).code).toBe('origin_mismatch');
    expect(storedTicket(ticket).status).toBe('waiting');
    expect(() =>
      openInspectionTicket(
        { tier: 'personal' },
        { ttlMs: 60_000, allowedOrigin: 'https://x.test/path' }
      )
    ).toThrow(InspectionHandoffError);
  });

  it('fails closed for a confidential hand-off when the audit chain cannot record it', async () => {
    const ticket = open({ tier: 'confidential', tenant_slug: 'acme' });
    vi.spyOn(auditChain, 'record').mockImplementation(() => {
      throw new Error('audit disk full');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reply = await submit(ticket);
    stderr.mockRestore();
    vi.restoreAllMocks();
    expect(reply.code).toBe('audit_unavailable');
    const stored = storedTicket(ticket);
    expect(stored.status).toBe('waiting');
    expect(stored).not.toHaveProperty('inspection');
  });

  it('never lets a polling CLI see the inspection before its audit record exists', async () => {
    for (const scope of [
      { tier: 'confidential', tenant_slug: 'acme' },
      { tier: 'personal' },
    ] as const) {
      const ticket = open(scope);
      const seenDuringAudit: Array<Record<string, unknown>> = [];
      const original = auditChain.record.bind(auditChain);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.spyOn(auditChain, 'record').mockImplementation((entry) => {
        if (entry.action === 'browser_bridge_submit_inspection' && entry.result === 'completed') {
          // A slow, then failing, audit write: the CLI polls in the meantime.
          seenDuringAudit.push(storedTicket(ticket));
          throw new Error('audit disk full');
        }
        return original(entry);
      });
      const reply = await submit(ticket);
      vi.restoreAllMocks();
      stderr.mockRestore();
      expect(seenDuringAudit).toHaveLength(1);
      expect(seenDuringAudit[0].status).toBe('waiting');
      expect(seenDuringAudit[0]).not.toHaveProperty('inspection');
      if (scope.tier === 'confidential') {
        expect(reply.code).toBe('audit_unavailable');
        // The CLI keeps polling until its deadline and never receives the data.
        await expect(
          awaitInspectionTicket(ticket, {
            now: () => new Date(Date.parse(ticket.expires_at) + 1),
          })
        ).rejects.toMatchObject({ code: 'timeout' });
      } else {
        // Non-confidential: the failed audit only warns, then the ticket is written.
        expect(reply.ok).toBe(true);
        expect(storedTicket(ticket).status).toBe('submitted');
      }
    }
  });

  it('refuses to open a confidential ticket the audit chain cannot record', () => {
    vi.spyOn(auditChain, 'record').mockImplementation(() => {
      throw new Error('audit disk full');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() =>
      openInspectionTicket({ tier: 'confidential', tenant_slug: 'acme' }, { ttlMs: 60_000 })
    ).toThrow(/AUDIT_UNAVAILABLE/);
    stderr.mockRestore();
  });

  it('still delivers a personal hand-off when the audit write fails', async () => {
    const ticket = open({ tier: 'personal' });
    vi.spyOn(auditChain, 'record').mockImplementation(() => {
      throw new Error('audit disk full');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect((await submit(ticket)).ok).toBe(true);
    stderr.mockRestore();
  });

  it('records a failed audit when the ticket write fails after the delivery was audited', async () => {
    const ticket = open({ tier: 'personal' });
    const audit = vi.spyOn(auditChain, 'record');
    writeFault.failSubmitted = true;
    let reply: Reply;
    try {
      reply = await submit(ticket);
    } finally {
      writeFault.failSubmitted = false;
    }
    expect(reply.ok).toBe(false);
    const results = audit.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.action === 'browser_bridge_submit_inspection')
      .map((entry) => entry.result);
    expect(results).toEqual(['completed', 'failed']);
    expect(storedTicket(ticket).status).toBe('waiting');
  });

  it('sweeps expired tickets', async () => {
    const stale = open({ tier: 'personal' }, 1_000, new Date(Date.now() - 10_000));
    const live = open({ tier: 'personal' });
    expect((await submit(live)).ok).toBe(true);
    expect(asConcierge(() => safeExistsSync(ticketFile(stale)))).toBe(false);
  });

  it('sweeps submitted tickets left behind by a crashed CLI once the grace has passed', async () => {
    const now = Date.now();
    const crashed = open({ tier: 'personal' }, 60_000, new Date(now - 10 * 60_000));
    submitInspectionToWaitingTicket(inspection(), {
      pairingCode: crashed.pairing_code,
      clock: () => new Date(now - 10 * 60_000 + 1_000),
    });
    expect(storedTicket(crashed).status).toBe('submitted');
    // Deliver the recent ticket at a time when the crashed one is still within its grace.
    const recent = open({ tier: 'personal' }, 9 * 60_000 - 30_000, new Date(now - 10 * 60_000));
    submitInspectionToWaitingTicket(inspection(), {
      pairingCode: recent.pairing_code,
      clock: () => new Date(now - 10 * 60_000 + 2_000),
    });
    const live = open({ tier: 'personal' });
    expect((await submit(live)).ok).toBe(true);
    expect(asConcierge(() => safeExistsSync(ticketFile(crashed)))).toBe(false);
    // Expired 90 s ago: still inside the 2-minute grace, so a slow CLI can collect it.
    expect(storedTicket(recent).status).toBe('submitted');
  });

  it('salts each ticket: the same code yields different digests', () => {
    const a = open({ tier: 'personal' });
    const b = open({ tier: 'personal' });
    const storedA = storedTicket(a);
    const storedB = storedTicket(b);
    expect(storedA.pairing_salt).toMatch(/^[0-9a-f]{32}$/);
    expect(storedA.pairing_salt).not.toBe(storedB.pairing_salt);
    expect(storedA.pairing_code_sha256).not.toBe(
      createHash('sha256').update(`browser-inspection-pairing:${a.pairing_code}`).digest('hex')
    );
  });

  it('returns an inspection that lands at the CLI deadline instead of discarding it', async () => {
    const ticket = open({ tier: 'personal' });
    let submitted = false;
    const clock = () => {
      if (!submitted) {
        submitted = true;
        // The host delivers between the CLI's last read and its deadline check.
        submitInspectionToWaitingTicket(inspection(), { pairingCode: ticket.pairing_code });
      }
      return new Date(Date.parse(ticket.expires_at) + 1);
    };
    const received = await awaitInspectionTicket(ticket, { now: clock, pollMs: 50 });
    expect(received.url).toBe('https://example.com/login');
    expect(asConcierge(() => safeExistsSync(ticketFile(ticket)))).toBe(false);
  });

  it('times out and removes the ticket when nothing arrives', async () => {
    const ticket = open({ tier: 'personal' });
    await expect(
      awaitInspectionTicket(ticket, { now: () => new Date(Date.parse(ticket.expires_at) + 1) })
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(asConcierge(() => safeExistsSync(ticketFile(ticket)))).toBe(false);
  });
});

describe('inspect_browser_page --mode extension (end to end through the host)', () => {
  it('receives the inspection the extension submits with the printed pairing code', async () => {
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
    // Read the pairing code the CLI printed, then submit as the extension would.
    let code = '';
    await vi.waitFor(
      () => {
        const printed = stderr.mock.calls.map((call) => String(call[0])).join('');
        code = printed.match(/Pairing code: ([A-Z0-9]{6})/)?.[1] ?? '';
        expect(code).not.toBe('');
      },
      { timeout: 5_000, interval: 20 }
    );
    const reply = await submit(code);
    expect(reply.ok).toBe(true);
    const report = await pending;
    expect(report).toMatchObject({ mode: 'extension', url: 'https://example.com/login' });
    expect(print).toHaveBeenCalledWith(expect.stringContaining('"mode": "extension"'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('com.kyberion.browser_bridge'));
    const left = asConcierge(() => (safeExistsSync(dir) ? safeReaddir(dir) : []));
    expect(left).not.toContain(`${reply.ticket_id}.json`);
  });
});
