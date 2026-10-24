import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from './authority.js';
import { rootDir } from './path-resolver.js';
import * as initialIO from './secure-io.js';

/**
 * CD-10 / CD-11 hardening: the operator tasks a customer-triggered respond or
 * the reminder sweep adds to the deliverable inbox are written as the narrow
 * `deliverable_inbox_writer` role (never `surface_runtime`), on a fresh root
 * with the real tier guard and the real addInboxEntry (no mocks). The role
 * writes the inbox and its own lock, and nothing else under
 * active/shared/runtime/.
 */
const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-inbox-writer-' + process.pid);
const TENANT = 'cd-inbox-writer';
const savedRoot = process.env.KYBERION_ROOT;
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

let io: typeof import('./secure-io.js');
let authority: typeof import('./authority.js');
let inbox: typeof import('./deliverable-inbox.js');
let boltReview: typeof import('./mission/mission-bolt-review.js');
let handoff: typeof import('./customer-decision/operator-handoff.js');
let writer: typeof import('./foundation/deliverable-inbox-writer-capability.js');

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"cd-inbox-writer-fixture"}');
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
    copy('knowledge/product/orchestration');
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime/locks'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('./secure-io.js');
  authority = await import('./authority.js');
  inbox = await import('./deliverable-inbox.js');
  boltReview = await import('./mission/mission-bolt-review.js');
  handoff = await import('./customer-decision/operator-handoff.js');
  writer = await import('./foundation/deliverable-inbox-writer-capability.js');
  expect((await import('./path-resolver.js')).rootDir()).toBe(ROOT);
}, 120_000);

beforeEach(() => {
  for (const key of keys) delete process.env[key];
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const asWriter = <T>(fn: () => T): T =>
  authority.withExecutionContext(writer.DELIVERABLE_INBOX_WRITER_ROLE, fn);
const entries = () => asWriter(() => inbox.listInboxEntries({ limit: 50 }));

describe('deliverable_inbox_writer on the real tier guard', () => {
  it('records a bolt-review rejection from the customer room identity (CD-10)', () => {
    // The identity the customer room gives the facade child.
    process.env.SYSTEM_ROLE = 'customer_room';
    process.env.KYBERION_TENANT = TENANT;
    const notice = boltReview.notifyBoltReviewRejected({
      tenantSlug: TENANT,
      caseId: 'case-a',
      agendaId: 'agd-inbox0001',
      entryId: 'bolt.review',
      ref: 'D-0001',
      missionId: 'MSN-INBOX-BOLT',
    });
    delete process.env.SYSTEM_ROLE;
    delete process.env.KYBERION_TENANT;
    expect(notice.inbox_entry_id).toMatch(/^INBOX-/u);
    const added = entries().find((entry) => entry.entry_id === notice.inbox_entry_id);
    expect(added).toMatchObject({
      kind: 'customer_decision_bolt_rejected',
      mission_id: 'MSN-INBOX-BOLT',
      tenant_slug: TENANT,
    });
    // A re-run adds nothing.
    boltReview.notifyBoltReviewRejected({
      tenantSlug: TENANT,
      caseId: 'case-a',
      agendaId: 'agd-inbox0001',
      entryId: 'bolt.review',
      ref: 'D-0001',
      missionId: 'MSN-INBOX-BOLT',
    });
    expect(entries().filter((entry) => entry.entry_id === notice.inbox_entry_id)).toHaveLength(1);
  });

  it('records the CD-11 operator hand-off task', () => {
    const notice = handoff.notifyCustomerDecisionHandoff({
      tenantSlug: TENANT,
      caseId: 'case-a',
      agendaId: 'agd-inbox0001',
      target: { receipt_id: 'rcp-inbox0001', off_option: 1, comments: 0, general_question: 0 },
    });
    expect(entries().find((entry) => entry.entry_id === notice.inbox_entry_id)).toMatchObject({
      kind: 'customer_decision_handoff',
      tenant_slug: TENANT,
    });
  });

  it('may only append to the shared inbox: a forged rewrite is refused', () => {
    const file = path.join(ROOT, 'active/shared/inbox/entries.jsonl');
    const current = asWriter(() => String(io.safeReadFile(file, { encoding: 'utf8' })));
    const existing = current.split('\n').filter(Boolean);
    expect(existing.length).toBeGreaterThan(0);
    const refused = /DELIVERABLE_INBOX_WRITE_REFUSED/u;
    // Dropping another tenant's entry.
    expect(() =>
      asWriter(() => io.safeWriteFile(file, `${existing.slice(1).join('\n')}\n`))
    ).toThrow(refused);
    // Rewriting one in place.
    const forged = { ...JSON.parse(existing[0]!), title: 'forged', tenant_slug: 'other' };
    expect(() =>
      asWriter(() =>
        io.safeWriteFile(file, [JSON.stringify(forged), ...existing.slice(1)].join('\n') + '\n')
      )
    ).toThrow(refused);
    // Re-adding an existing id, or a line that is not an entry.
    expect(() => asWriter(() => io.safeWriteFile(file, `${current}${existing[0]}\n`))).toThrow(
      refused
    );
    expect(() => asWriter(() => io.safeWriteFile(file, `${current}[1]\n`))).toThrow(refused);
    expect(() => asWriter(() => io.safeAppendFileSync(file, '{}\n'))).toThrow(refused);
    // The store's own append still works.
    const added = asWriter(() =>
      inbox.addInboxEntry({
        title: 'Appended',
        tenantSlug: TENANT,
        kind: 'customer_decision_handoff',
      })
    );
    expect(entries().map((entry) => entry.entry_id)).toContain(added.entry_id);
    expect(String(asWriter(() => io.safeReadFile(file, { encoding: 'utf8' })))).toContain(current);
  });

  it('cannot write active/shared/runtime/ beyond the inbox lock, nor other shared stores', () => {
    const denied = /DELIVERABLE_INBOX_WRITER_SCOPE/u;
    expect(() =>
      asWriter(() =>
        io.safeWriteFile(path.join(ROOT, 'active/shared/runtime/approvals/x.json'), '{}')
      )
    ).toThrow(denied);
    expect(() =>
      asWriter(() => io.safeWriteFile(path.join(ROOT, 'active/shared/runtime/state.json'), '{}'))
    ).toThrow(denied);
    expect(() =>
      asWriter(() =>
        io.safeWriteFile(path.join(ROOT, 'active/shared/runtime/locks/approvals.lock'), '{}')
      )
    ).toThrow(denied);
    expect(() =>
      asWriter(() => io.safeWriteFile(path.join(ROOT, 'active/shared/inbox/other.jsonl'), ''))
    ).toThrow(denied);
    expect(() =>
      asWriter(() =>
        io.safeMkdir(path.join(ROOT, 'active/shared/runtime/elsewhere'), { recursive: true })
      )
    ).toThrow(denied);
    // Outside its policy grant entirely.
    expect(() =>
      asWriter(() => io.safeWriteFile(path.join(ROOT, 'active/shared/coordination/x.json'), '{}'))
    ).toThrow();
  });

  it('the path rule allows exactly the inbox file, its directories and the inbox lock', () => {
    const lock = `active/shared/runtime/locks/deliverable-inbox-${'a'.repeat(64)}.lock`;
    expect(
      writer.deliverableInboxWriterPathAllowed('active/shared/inbox/entries.jsonl', 'write')
    ).toBe(true);
    expect(writer.deliverableInboxWriterPathAllowed(lock, 'write')).toBe(true);
    expect(writer.deliverableInboxWriterPathAllowed(`${lock}.reclaim`, 'write')).toBe(true);
    expect(writer.deliverableInboxWriterPathAllowed('active/shared/inbox', 'mkdir')).toBe(true);
    expect(
      writer.deliverableInboxWriterPathAllowed('active/shared/runtime/locks/../x.lock', 'write')
    ).toBe(false);
    expect(
      writer.deliverableInboxWriterPathAllowed(
        'active/shared/runtime/locks/deliverable-inbox-x.lock',
        'write'
      )
    ).toBe(false);
  });

  it('appends after a malformed and an older-format line, keeping both byte-identical', () => {
    const file = path.join(ROOT, 'active/shared/inbox/entries.jsonl');
    const current = asWriter(() => String(io.safeReadFile(file, { encoding: 'utf8' })));
    const malformed = '{"entry_id": "INBOX-BROKEN", truncated';
    // Older format: other key order, spacing, no kind / tenant fields.
    const older =
      '{"title":"Old deliverable","entry_id":"INBOX-OLD00001","status":"unread", "artifact_paths":[],"summary":"","created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}';
    const seeded = `${current}${malformed}\n${older}`; // no trailing newline
    authority.withExecutionContext('surface_runtime', () => io.safeWriteFile(file, seeded));
    const added = asWriter(() =>
      inbox.addInboxEntry({
        entryId: 'INBOX-AFTER-ODD',
        ifAbsent: true,
        title: 'After odd lines',
        tenantSlug: TENANT,
        kind: 'customer_decision_handoff',
      })
    );
    expect(added.entry_id).toBe('INBOX-AFTER-ODD');
    const after = asWriter(() => String(io.safeReadFile(file, { encoding: 'utf8' })));
    expect(after.startsWith(`${seeded}\n`)).toBe(true);
    expect(after.split('\n').filter(Boolean).at(-1)).toContain('INBOX-AFTER-ODD');
    // ifAbsent finds the existing entry tolerantly; the older line is found too.
    const again = asWriter(() =>
      inbox.addInboxEntry({
        entryId: 'INBOX-AFTER-ODD',
        ifAbsent: true,
        title: 'After odd lines',
        tenantSlug: TENANT,
        kind: 'customer_decision_handoff',
      })
    );
    expect(again.entry_id).toBe('INBOX-AFTER-ODD');
    expect(asWriter(() => String(io.safeReadFile(file, { encoding: 'utf8' })))).toBe(after);
  });
});
