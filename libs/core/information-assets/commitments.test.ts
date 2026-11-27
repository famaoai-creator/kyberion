import { describe, expect, it } from 'vitest';
import {
  commitmentOwnerSide,
  informationArtifactSourceOf,
  informationMatterOf,
  normalizeMatterTitle,
  projectCommitments,
  renderCommitmentDigest,
  type CommitmentProjectionEntry,
} from './commitments.js';
import type { InformationAssetObservation } from './types.js';

const now = new Date('2026-11-27T09:00:00Z');
function observation(
  overrides: Partial<InformationAssetObservation> & Pick<InformationAssetObservation, 'data'>
): InformationAssetObservation {
  return {
    scope: { tenant_slug: 'acme', organization_id: 'engineering' },
    asset_type: 'customer.request',
    location_id: 'inbox',
    binding_id: 'google-acme',
    service_id: 'google-workspace',
    subject_id: 'm1',
    change_id: '100',
    event_type: 'message.observed',
    event_id: 'a'.repeat(64),
    content_sha256: 'b'.repeat(64),
    observed_at: now.toISOString(),
    ...overrides,
  };
}
const mail = observation({
  occurred_at: '2026-11-26T10:00:00Z',
  source_url: 'https://mail.google.com/mail/u/0/#all/m1',
  data: {
    id: 'm1',
    threadId: 't1',
    payload: { headers: [{ name: 'Subject', value: 'Re: Q4 pricing proposal' }] },
  },
});
const meeting = (phase: 'upcoming' | 'ended') =>
  observation({
    asset_type: 'calendar.meeting',
    subject_id: 'primary/e1',
    change_id: phase + ':"1"',
    event_type: 'meeting.' + phase,
    occurred_at: phase === 'upcoming' ? '2026-11-27T13:00:00Z' : '2026-11-26T14:00:00Z',
    data: {
      id: 'e1',
      calendar_id: 'primary',
      summary: 'Q4 pricing proposal',
      start: '2026-11-27T13:00:00Z',
      end: '2026-11-27T14:00:00Z',
    },
  });
function artifact(
  obs: InformationAssetObservation,
  recipe: string,
  body: {
    summary?: string;
    category?: string;
    reply_draft?: string;
    actions: Array<{ title: string; owner: string | null; due_at: string | null }>;
  }
): CommitmentProjectionEntry {
  return {
    work_item_id: 'wi-' + obs.subject_id + '-' + obs.event_type,
    work_key: 'c'.repeat(64),
    artifact_ref: 'artifacts/' + obs.subject_id + '.json',
    artifact: {
      recipe_id: recipe,
      subject_id: obs.subject_id,
      change_id: obs.change_id,
      matter: informationMatterOf(obs),
      source: informationArtifactSourceOf(obs),
      summary: body.summary ?? 'summary',
      category: body.category ?? 'action_required',
      reply_draft: body.reply_draft ?? '',
      actions: body.actions,
    },
  };
}

describe('matter derivation', () => {
  it('groups mail by Gmail thread and meetings by calendar series', () => {
    expect(informationMatterOf(mail)).toEqual({
      key: 'mail-thread:t1',
      title: 'Re: Q4 pricing proposal',
    });
    const recurring = meeting('ended');
    (recurring.data as Record<string, unknown>).recurring_event_id = 'series-9';
    expect(informationMatterOf(recurring).key).toBe('meeting:primary/series-9');
    expect(informationArtifactSourceOf(meeting('upcoming'))).toMatchObject({
      start: '2026-11-27T13:00:00Z',
      end: '2026-11-27T14:00:00Z',
    });
  });
  it('normalizes reply and forward prefixes in several languages', () => {
    expect(normalizeMatterTitle('RE: Fwd:  Q4   Pricing')).toBe('q4 pricing');
    expect(normalizeMatterTitle('返信： 見積もり')).toBe('見積もり');
  });
  it('strips stacked prefixes with counters and handles a long whitespace run after a token', () => {
    expect(normalizeMatterTitle('Fwd[2]: RE : fw: Budget')).toBe('budget');
    expect(normalizeMatterTitle('Reply needed')).toBe('reply needed');
    expect(normalizeMatterTitle('Re[]: x')).toBe('re[]: x');
    const hostile = 're' + '\t'.repeat(50000) + '!';
    expect(normalizeMatterTitle(hostile)).toBe('re !');
  });
  it('classifies owners against the caller identities only', () => {
    expect(commitmentOwnerSide('me@acme.test', ['ME@acme.test'])).toBe('self');
    expect(commitmentOwnerSide('Sam <me@acme.test>', ['me@acme.test'])).toBe('self');
    expect(commitmentOwnerSide('自分', [])).toBe('self');
    expect(commitmentOwnerSide('pat@client.test', ['me@acme.test'])).toBe('counterpart');
    expect(commitmentOwnerSide(null, ['me@acme.test'])).toBe('unknown');
  });
});

describe('commitment projection', () => {
  const entries = [
    artifact(mail, 'email.action_extraction', {
      reply_draft: 'Thanks, I will send the revised sheet.',
      actions: [
        {
          title: 'Send revised pricing sheet',
          owner: 'me@acme.test',
          due_at: '2026-11-26T18:00:00Z',
        },
        { title: 'Confirm budget', owner: 'pat@client.test', due_at: '2026-12-01T00:00:00Z' },
        { title: 'Book a room', owner: null, due_at: null },
      ],
    }),
    artifact(meeting('upcoming'), 'calendar.meeting_prep', {
      summary: 'Decide on the discount tier',
      category: 'information',
      actions: [{ title: 'Read last quarter numbers', owner: null, due_at: null }],
    }),
    artifact(meeting('ended'), 'calendar.meeting_followup', {
      category: 'information',
      actions: [{ title: 'Share minutes', owner: 'me@acme.test', due_at: '2026-11-28T00:00:00Z' }],
    }),
  ];

  it('splits owed, waiting and unassigned commitments and orders overdue first', () => {
    const projection = projectCommitments(entries, {
      selfIdentities: ['me@acme.test'],
      now,
    });
    expect(projection.commitments.map((c) => [c.title, c.state])).toEqual([
      ['Send revised pricing sheet', 'overdue'],
      ['Share minutes', 'open'],
      ['Book a room', 'unassigned'],
      ['Confirm budget', 'waiting'],
    ]);
    expect(projection.commitments[0]!.source).toEqual({
      work_item_id: 'wi-m1-message.observed',
      work_key: 'c'.repeat(64),
      recipe_id: 'email.action_extraction',
      subject_id: 'm1',
      artifact_ref: 'artifacts/m1.json',
    });
    expect(projection.skipped).toEqual([]);
  });

  it('lists preparation with the meeting instead of as commitments', () => {
    const projection = projectCommitments(entries, { now });
    expect(projection.meetings.map((m) => [m.phase, m.preparation])).toEqual([
      ['ended', []],
      ['upcoming', ['Read last quarter numbers']],
    ]);
    expect(projection.commitments.map((c) => c.title)).not.toContain('Read last quarter numbers');
  });

  it('stitches a mail thread and a meeting with the same normalized title into one matter', () => {
    const projection = projectCommitments(entries, { now });
    expect(projection.matters).toHaveLength(1);
    expect(projection.matters[0]).toMatchObject({
      matter_key: 'mail-thread:t1',
      linked_keys: ['meeting:primary/e1'],
    });
    expect(projection.matters[0]!.commitment_ids).toHaveLength(4);
  });

  it('keeps one commitment when a newer message extracts the same action again', () => {
    const newer = observation({
      ...mail,
      subject_id: 'm2',
      change_id: '200',
      occurred_at: '2026-11-27T08:00:00Z',
    });
    const projection = projectCommitments(
      [
        entries[0]!,
        artifact(newer, 'email.action_extraction', {
          actions: [
            {
              title: 'send revised  pricing sheet',
              owner: 'me@acme.test',
              due_at: '2026-11-30T00:00:00Z',
            },
          ],
        }),
      ],
      { selfIdentities: ['me@acme.test'], now }
    );
    const sheet = projection.commitments.filter((c) => /pricing sheet/i.test(c.title));
    expect(sheet).toHaveLength(1);
    expect(sheet[0]).toMatchObject({ due_at: '2026-11-30T00:00:00Z', state: 'open' });
  });

  it('marks late counterparts, treats date-only dues as end of day, and hides started meetings', () => {
    const projection = projectCommitments(
      [
        artifact(mail, 'email.action_extraction', {
          actions: [
            { title: 'Due today', owner: 'me@acme.test', due_at: '2026-11-27' },
            { title: 'Sign contract', owner: 'pat@client.test', due_at: '2026-11-20' },
          ],
        }),
        artifact(meeting('upcoming'), 'calendar.meeting_prep', { actions: [] }),
      ],
      { selfIdentities: ['me@acme.test'], now: new Date('2026-11-27T13:30:00Z') }
    );
    expect(projection.commitments.map((c) => [c.title, c.state, c.late])).toEqual([
      ['Due today', 'open', false],
      ['Sign contract', 'waiting', true],
    ]);
    expect(projection.meetings).toEqual([]);
    expect(renderCommitmentDigest(projection)).toContain(
      '- **LATE** pat@client.test: Sign contract'
    );
  });

  it('orders repeated mail observations by capture time, using internalDate for Gmail', () => {
    const older = observation({
      ...mail,
      occurred_at: undefined,
      observed_at: '2026-11-27T07:00:00Z',
      data: { ...mail.data, internalDate: String(Date.parse('2026-11-27T06:00:00Z')) },
    });
    const newer = observation({
      ...older,
      subject_id: 'm2',
      observed_at: '2026-11-27T08:00:00Z',
    });
    expect(informationArtifactSourceOf(older).occurred_at).toBe('2026-11-27T06:00:00.000Z');
    const run = (order: CommitmentProjectionEntry[]) =>
      projectCommitments(order, { selfIdentities: ['me@acme.test'], now }).commitments;
    const a = artifact(older, 'email.action_extraction', {
      actions: [{ title: 'Send contract', owner: 'me@acme.test', due_at: '2026-12-01T00:00:00Z' }],
    });
    const b = artifact(newer, 'email.action_extraction', {
      actions: [
        { title: 'Send contract', owner: 'pat@client.test', due_at: '2026-12-05T00:00:00Z' },
      ],
    });
    expect(run([a, b])).toEqual(run([b, a]));
    expect(run([a, b])[0]).toMatchObject({ owner: 'pat@client.test', state: 'waiting' });
  });

  it('reports unreadable or malformed artifacts instead of dropping them', () => {
    const projection = projectCommitments(
      [
        {
          work_item_id: 'wi-bad',
          work_key: 'd'.repeat(64),
          artifact_ref: 'x',
          artifact: null,
          error: 'artifact_hash_mismatch',
        },
        {
          work_item_id: 'wi-odd',
          work_key: 'd'.repeat(64),
          artifact_ref: 'y',
          artifact: { summary: 1 },
        },
      ],
      { now }
    );
    expect(projection.skipped).toEqual([
      { work_item_id: 'wi-bad', reason: 'artifact_hash_mismatch' },
      { work_item_id: 'wi-odd', reason: 'artifact_missing_recipe_id' },
    ]);
  });

  it('renders a digest with drafts, meetings, owed and waiting sections', () => {
    const digest = renderCommitmentDigest(
      projectCommitments(entries, { selfIdentities: ['me@acme.test'], now })
    );
    expect(digest).toContain('## Reply drafts to review (1)');
    expect(digest).toContain('> Thanks, I will send the revised sheet.');
    expect(digest).toContain('Not sent.');
    expect(digest).toContain('- **2026-11-27T13:00:00Z** Q4 pricing proposal');
    expect(digest).toContain('  - [ ] Read last quarter numbers');
    expect(digest).toContain('- **OVERDUE** Send revised pricing sheet — due 2026-11-26T18:00:00Z');
    expect(digest).toContain('## Waiting on others (1)');
    expect(digest).toContain('- pat@client.test: Confirm budget');
  });
});
