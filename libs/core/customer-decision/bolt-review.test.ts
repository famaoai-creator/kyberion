import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  MAX_ATTACHMENT_BYTES,
  agendaAttachmentIds,
  boltMilestone,
  boltRejectInboxEntryId,
  boltReworkWorkItemId,
  boltRoutingTargets,
  checkAttachmentBytes,
  isBoltTargetRouted,
  linkProblem,
  sniffImageMediaType,
} from './bolt-review.js';
import { agendaContentHash } from './hash.js';
import type { DecisionAgenda, DecisionReceipt } from './model.js';
import {
  customerDecisionPaths,
  readAgenda,
  readAgendaAttachment,
  writeAgenda,
  writeAgendaAttachment,
} from './store.js';

const NOW = '2026-10-24T00:00:00.000Z';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);

function boltAgenda(overrides: Partial<DecisionAgenda> = {}): DecisionAgenda {
  return {
    version: '1.0.0',
    agenda_id: 'agd-bolt0001',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    customer: 'acme',
    title: 'Review of the latest results',
    phase: 'aidlc_construction',
    revision: 1,
    locale: 'en',
    bolt_mission_id: 'MSN-BOLT-1',
    entries: [
      {
        entry_id: 'bolt_review',
        item: 'bolt:MSN-BOLT-1',
        key: 'bolt.acceptance',
        kind: 'approval',
        question: 'Do you accept the results of this bolt?',
        background: 'What changed: the order form.',
        our_decision: { value: { approved: true } },
        requires_customer: false,
        override_until: { kind: 'milestone', milestone: boltMilestone('MSN-BOLT-1') },
        attachments: [
          {
            id: createHash('sha256').update(PNG).digest('hex'),
            name: 'form.png',
            media_type: 'image/png',
            bytes: PNG.length,
          },
        ],
        links: [{ label: 'Preview', url: 'https://preview.example.com/b1' }],
      },
    ],
    status: 'draft',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function receipt(
  receiptId: string,
  answers: DecisionReceipt['answers'],
  decisionIds: string[],
  role: 'decider' | 'contributor' = 'decider'
): DecisionReceipt {
  return {
    version: '1.0.0',
    receipt_id: receiptId,
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agenda_id: 'agd-bolt0001',
    agenda_revision: 1,
    content_hash: 'a'.repeat(64),
    invite_id: 'inv-0123456789abcdef',
    participant: { name: 'Hanako', role, actor_id: 'customer:acme-cto' },
    answers,
    identity_assurance: 'invite_link',
    submitted_at: NOW,
    decision_ids: decisionIds,
  };
}

describe('bolt review links', () => {
  it('accepts public https URLs only', () => {
    expect(linkProblem('https://preview.example.com/build/42?x=1')).toBeNull();
    expect(linkProblem('https://8.8.8.8/')).toBeNull();
    expect(linkProblem('https://[2606:4700::1111]/')).toBeNull();
  });

  it.each([
    ['http://preview.example.com/', 'not_https'],
    ['ftp://preview.example.com/', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['not a url', 'invalid_url'],
    ['https://user:pw@preview.example.com/', 'credentials'],
    ['https://localhost:3000/', 'internal_host'],
    ['https://app.localhost/', 'internal_host'],
    ['https://staging.local/', 'internal_host'],
    ['https://api.corp.internal/', 'internal_host'],
    ['https://nas.lan/', 'internal_host'],
    ['https://STAGING.LOCAL./', 'internal_host'],
    ['https://intranet/', 'bare_host'],
    ['https://127.0.0.1/', 'private_address'],
    ['https://2130706433/', 'private_address'],
    ['https://0x7f.1/', 'private_address'],
    ['https://10.1.2.3/', 'private_address'],
    ['https://172.16.0.1/', 'private_address'],
    ['https://172.31.255.255/', 'private_address'],
    ['https://192.168.1.10/', 'private_address'],
    ['https://169.254.169.254/latest/meta-data', 'private_address'],
    ['https://100.64.0.1/', 'private_address'],
    ['https://0.0.0.0/', 'private_address'],
    ['https://[::1]/', 'private_address'],
    ['https://[::]/', 'private_address'],
    ['https://[fd00::1]/', 'private_address'],
    ['https://[fe80::1]/', 'private_address'],
    ['https://[::ffff:127.0.0.1]/', 'private_address'],
    ['https://[::127.0.0.1]/', 'private_address'],
    ['https://[::7f00:1]/', 'private_address'],
    ['https://[64:ff9b::7f00:1]/', 'private_address'],
    ['https://[2002:7f00:1::1]/', 'private_address'],
    ['https://[2001:0:4136:e378::1]/', 'private_address'],
    ['https://staging.local../', 'internal_host'],
  ])('refuses %s (%s)', (url, problem) => {
    expect(linkProblem(url)).toBe(problem);
  });

  it('refuses non-strings and oversized URLs', () => {
    expect(linkProblem(undefined)).toBe('invalid_url');
    expect(linkProblem(`https://example.com/${'a'.repeat(2000)}`)).toBe('invalid_url');
  });
});

describe('bolt review attachments', () => {
  it('sniffs png, jpeg and webp from the bytes', () => {
    expect(sniffImageMediaType(PNG)).toBe('image/png');
    expect(sniffImageMediaType(JPEG)).toBe('image/jpeg');
    expect(sniffImageMediaType(WEBP)).toBe('image/webp');
    expect(sniffImageMediaType(Buffer.from('GIF89a'))).toBeNull();
  });

  it('refuses empty, oversized, unsupported and mismatched images', () => {
    expect(checkAttachmentBytes('a.png', PNG)).toMatchObject({ ok: true, media_type: 'image/png' });
    expect(checkAttachmentBytes('a.JPEG', JPEG)).toMatchObject({
      ok: true,
      media_type: 'image/jpeg',
    });
    expect(checkAttachmentBytes('a.png', Buffer.alloc(0))).toEqual({ ok: false, problem: 'empty' });
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    expect(checkAttachmentBytes('a.png', big)).toEqual({ ok: false, problem: 'too_large' });
    expect(checkAttachmentBytes('a.gif', PNG)).toEqual({ ok: false, problem: 'unsupported_type' });
    expect(checkAttachmentBytes('a.svg', PNG)).toEqual({ ok: false, problem: 'unsupported_type' });
    // A file named .png that is a jpeg (or HTML) is refused.
    expect(checkAttachmentBytes('a.png', JPEG)).toEqual({ ok: false, problem: 'type_mismatch' });
    expect(checkAttachmentBytes('a.png', Buffer.from('<html>'))).toEqual({
      ok: false,
      problem: 'type_mismatch',
    });
  });

  it('binds attachments and links into the content hash', () => {
    const agenda = boltAgenda();
    const hash = agendaContentHash(agenda);
    const otherImage = boltAgenda();
    otherImage.entries[0].attachments![0].id = 'b'.repeat(64);
    expect(agendaContentHash(otherImage)).not.toBe(hash);
    const otherLink = boltAgenda();
    otherLink.entries[0].links![0].url = 'https://preview.example.com/b2';
    expect(agendaContentHash(otherLink)).not.toBe(hash);
    // The mission id and the routing record are not shown, so not hashed.
    expect(
      agendaContentHash({
        ...agenda,
        bolt_mission_id: 'MSN-OTHER',
        bolt_routing: [{ entry_id: 'bolt_review', ref: 'D-0001', outcome: 'reject', at: NOW }],
      })
    ).toBe(hash);
    expect(agendaAttachmentIds(agenda)).toEqual(new Set([agenda.entries[0].attachments![0].id]));
  });
});

describe('bolt review answers', () => {
  it('routes a decider request_changes / reject once per decision or change request', () => {
    const agenda = boltAgenda();
    const receipts = [
      receipt(
        'rcp-0000000000000001',
        [{ entry_id: 'bolt_review', choice: 'request_changes', comment: 'c', outcome: 'decided' }],
        ['D-0002']
      ),
      // The same answer again: unchanged, no new target.
      receipt(
        'rcp-0000000000000002',
        [
          {
            entry_id: 'bolt_review',
            choice: 'request_changes',
            comment: 'c',
            outcome: 'unchanged',
          },
        ],
        []
      ),
      // After the next bolt started: a change request, keyed by its receipt.
      receipt(
        'rcp-0000000000000003',
        [{ entry_id: 'bolt_review', choice: 'reject', comment: 'no', outcome: 'change_request' }],
        []
      ),
      // A contributor's opinion is never routed.
      receipt(
        'rcp-0000000000000004',
        [{ entry_id: 'bolt_review', choice: 'reject', comment: 'no', outcome: 'opinion' }],
        [],
        'contributor'
      ),
      receipt(
        'rcp-0000000000000005',
        [{ entry_id: 'bolt_review', choice: 'approve', outcome: 'decided' }],
        ['D-0003']
      ),
    ];
    const targets = boltRoutingTargets(agenda, receipts);
    expect(targets).toEqual([
      { entry_id: 'bolt_review', ref: 'D-0002', outcome: 'request_changes' },
      { entry_id: 'bolt_review', ref: 'rcp-0000000000000003', outcome: 'reject' },
    ]);
    expect(boltRoutingTargets({ ...agenda, bolt_mission_id: undefined }, receipts)).toEqual([]);
    expect(
      isBoltTargetRouted(targets[0], [{ ...targets[0], work_item_id: 'WI-CDB-1', at: NOW }])
    ).toBe(true);
    expect(isBoltTargetRouted(targets[1], [{ ...targets[1], at: NOW }])).toBe(false);
    expect(boltReworkWorkItemId('agd-bolt0001', 'bolt_review', 'D-0002')).toBe(
      boltReworkWorkItemId('agd-bolt0001', 'bolt_review', 'D-0002')
    );
    expect(boltReworkWorkItemId('agd-bolt0001', 'bolt_review', 'D-0002')).toMatch(
      /^WI-CDB-[0-9A-F]{16}$/u
    );
    expect(boltRejectInboxEntryId('agd-bolt0001', 'bolt_review', 'D-0002')).toMatch(
      /^INBOX-CDB-[0-9A-F]{16}$/u
    );
  });
});

describe('bolt review store', () => {
  let dir: string;
  beforeEach(() => {
    dir = pathResolver.sharedTmp(`customer-decision-bolt-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
  });
  afterEach(() => safeRmSync(dir, { recursive: true, force: true }));

  it('stores an image content-addressed and reads it back verified', () => {
    const stored = writeAgendaAttachment({ dir }, 'shots/form.png', PNG);
    expect(stored).toEqual({
      id: createHash('sha256').update(PNG).digest('hex'),
      name: 'form.png',
      media_type: 'image/png',
      bytes: PNG.length,
    });
    expect(safeExistsSync(`${customerDecisionPaths({ dir }).attachments}/${stored.id}.png`)).toBe(
      true
    );
    // The same bytes again: the same record, no second file.
    expect(writeAgendaAttachment({ dir }, 'again.png', PNG).id).toBe(stored.id);
    expect(readAgendaAttachment({ dir }, stored)?.equals(PNG)).toBe(true);
    // A file whose bytes no longer match its id is never served.
    safeWriteFile(`${customerDecisionPaths({ dir }).attachments}/${stored.id}.png`, JPEG);
    expect(readAgendaAttachment({ dir }, stored)).toBeUndefined();
    expect(readAgendaAttachment({ dir }, { id: 'c'.repeat(64), media_type: 'image/png' })).toBe(
      undefined
    );
  });

  it('refuses oversized and mismatched images', () => {
    expect(() =>
      writeAgendaAttachment(
        { dir },
        'big.png',
        Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)])
      )
    ).toThrow(/CUSTOMER_DECISION_ATTACHMENT_TOO_LARGE/u);
    expect(() => writeAgendaAttachment({ dir }, 'fake.png', JPEG)).toThrow(
      /CUSTOMER_DECISION_ATTACHMENT_TYPE_MISMATCH/u
    );
    expect(() => readAgendaAttachment({ dir }, { id: '../x', media_type: 'image/png' })).toThrow(
      /ATTACHMENT_ID_INVALID/u
    );
  });

  it('validates attachments, links and the bolt fields against the schema', () => {
    const written = writeAgenda({ dir }, boltAgenda());
    expect(readAgenda({ dir }, written.agenda_id)?.bolt_mission_id).toBe('MSN-BOLT-1');
    const tooMany = boltAgenda();
    tooMany.entries[0].attachments = Array.from({ length: 7 }, (_, index) => ({
      id: String(index)
        .repeat(64)
        .slice(0, 64)
        .replace(/[^a-f0-9]/gu, 'a'),
      name: `${index}.png`,
      media_type: 'image/png' as const,
      bytes: 10,
    }));
    expect(() => writeAgenda({ dir }, tooMany)).toThrow();
    const httpLink = boltAgenda();
    httpLink.entries[0].links = [{ label: 'Preview', url: 'http://preview.example.com/' }];
    expect(() => writeAgenda({ dir }, httpLink)).toThrow();
    const svg = boltAgenda();
    // @ts-expect-error — the schema refuses a media type the model does not allow
    svg.entries[0].attachments![0].media_type = 'image/svg+xml';
    expect(() => writeAgenda({ dir }, svg)).toThrow();
  });
});
