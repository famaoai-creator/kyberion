import { describe, expect, it } from 'vitest';
import { applyHearingTurn, createHearingRecord, type HearingRecord } from './hearing.js';
import {
  buildHearingMissionCreateArgs,
  hearingMissionId,
  hearingRecordToMissionBrief,
  validateHearingMissionBrief,
  type HearingMissionMember,
  type MissionBrief,
} from './hearing-mission.js';

const REQUIREMENT_ANSWERS: Record<string, string> = {
  audience: 'Small clinics booking appointments',
  problem: 'Front desk staff double-book slots because there is no shared calendar',
  core_flow: 'Staff pick a slot, patient confirms by SMS, calendar updates',
  content: 'Calendar grid, patient contact card, SMS log',
  visual_direction: 'Calm, clinical, high contrast for low-vision staff',
  constraints: 'Must work offline for the first release',
  success: 'Two staff members can no longer double-book the same slot',
};

function decidedRecord(sessionId = 'sess-fixture'): HearingRecord {
  let record = createHearingRecord(sessionId, '2026-09-14T00:00:00.000Z');
  for (const item of record.requirements) {
    record = applyHearingTurn(
      record,
      {
        text: REQUIREMENT_ANSWERS[item.id] || `answer for ${item.id}`,
        request_id: `turn-${item.id}`,
      },
      '2026-09-14T00:01:00.000Z'
    );
  }
  return {
    ...record,
    decided_by: {
      kind: 'human',
      id: 'user:zz-hearing-member',
      display_name: 'ZZ Tester',
      role: 'approver',
    },
    decided_at: '2026-09-14T00:02:00.000Z',
  };
}

const MEMBER: HearingMissionMember = {
  id: 'user:zz-hearing-member',
  display_name: 'ZZ Tester',
  role: 'approver',
};

describe('hearingMissionId', () => {
  it('is stable per session and matches the mission id grammar', () => {
    const id = hearingMissionId({ session_id: 'sess-abc' });
    expect(id).toMatch(/^MSN-HEARING-[A-F0-9]{8}$/);
    expect(hearingMissionId({ session_id: 'sess-abc' })).toBe(id);
  });

  it('differs across sessions', () => {
    expect(hearingMissionId({ session_id: 'sess-abc' })).not.toBe(
      hearingMissionId({ session_id: 'sess-xyz' })
    );
  });
});

describe('hearingRecordToMissionBrief', () => {
  it('maps requirement answers onto a schema-valid brief with catalog-resolved labels', () => {
    const record = decidedRecord('sess-brief-1');
    const brief = hearingRecordToMissionBrief(record, {
      locale: 'en',
      tenantSlug: 'jisha',
      member: MEMBER,
    });

    expect(brief.missionId).toBe(hearingMissionId(record));
    expect(brief.tier).toBe('confidential');
    expect(brief.title).toContain('double-book');
    expect(brief.intent).toContain("Who it's for");
    expect(brief.intent).toContain(REQUIREMENT_ANSWERS.audience);
    expect(brief.victoryConditions).toEqual([REQUIREMENT_ANSWERS.success]);
    expect(brief.scope?.in?.join('\n')).toContain(REQUIREMENT_ANSWERS.core_flow);
    expect(brief.scope?.in?.join('\n')).toContain(REQUIREMENT_ANSWERS.content);
    expect(brief.scope?.out?.join('\n')).toContain(REQUIREMENT_ANSWERS.constraints);
    expect(brief.deliverables?.some((item) => item.includes(REQUIREMENT_ANSWERS.content))).toBe(
      true
    );
    expect(brief.roles).toEqual([{ who: 'ZZ Tester' }]);

    // Every fixed label came through the catalog, never inline copy.
    expect(brief.intent).not.toContain('undefined');

    expect(() => validateHearingMissionBrief(brief)).not.toThrow();
  });

  it('resolves labels per the requested locale', () => {
    const record = decidedRecord('sess-brief-locale');
    const ja = hearingRecordToMissionBrief(record, {
      locale: 'ja',
      tenantSlug: 'jisha',
      member: MEMBER,
    });
    expect(ja.intent).toContain('対象となる人');
  });

  it('rejects a malformed tenant slug before touching the schema', () => {
    const record = decidedRecord('sess-brief-tenant');
    expect(() =>
      hearingRecordToMissionBrief(record, { locale: 'en', tenantSlug: 'Not_Valid', member: MEMBER })
    ).toThrow(/tenantSlug must match/);
  });

  it('refuses an undecided/incomplete record (no problem answer to summarize)', () => {
    const record = createHearingRecord('sess-brief-incomplete', '2026-09-14T00:00:00.000Z');
    expect(() =>
      hearingRecordToMissionBrief(record, { locale: 'en', tenantSlug: 'jisha', member: MEMBER })
    ).toThrow(/no problem answer/);
  });
});

describe('validateHearingMissionBrief', () => {
  it('rejects a brief with an unknown field (schema additionalProperties: false)', () => {
    const brief = { title: 'ok', notAField: true } as unknown as MissionBrief;
    expect(() => validateHearingMissionBrief(brief)).toThrow();
  });
});

describe('buildHearingMissionCreateArgs', () => {
  const brief: MissionBrief = {
    missionId: 'MSN-HEARING-ABCDEF12',
    title: 'Front desk double-booking',
    intent: "Who it's for: clinics\nWhat it should solve: double-booking",
    victoryConditions: ['No more double-booked slots'],
  };

  it('builds the create argv with --goal, --success-condition, --tier, --tenant-slug, and decided-by flags', () => {
    const args = buildHearingMissionCreateArgs({
      missionId: brief.missionId as string,
      brief,
      tenantSlug: 'jisha',
      tier: 'confidential',
      decidedBy: { id: 'user:zz-hearing-member', display_name: 'ZZ Tester', role: 'approver' },
    });

    expect(args).toEqual([
      'create',
      'MSN-HEARING-ABCDEF12',
      '--tier',
      'confidential',
      '--tenant-slug',
      'jisha',
      '--goal',
      'Front desk double-booking',
      '--success-condition',
      'No more double-booked slots',
      '--decided-by',
      'user:zz-hearing-member',
      '--decided-by-name',
      'ZZ Tester',
      '--decided-by-role',
      'approver',
    ]);
  });

  it('omits --success-condition when the brief has no victory condition', () => {
    const args = buildHearingMissionCreateArgs({
      missionId: brief.missionId as string,
      brief: { ...brief, victoryConditions: undefined },
      tenantSlug: 'jisha',
      tier: 'confidential',
      decidedBy: { id: 'user:zz-hearing-member' },
    });
    expect(args).not.toContain('--success-condition');
    expect(args).not.toContain('--decided-by-name');
    expect(args).not.toContain('--decided-by-role');
  });

  it('rejects a malformed decided-by id (never an agent/service id)', () => {
    expect(() =>
      buildHearingMissionCreateArgs({
        missionId: brief.missionId as string,
        brief,
        tenantSlug: 'jisha',
        tier: 'confidential',
        decidedBy: { id: 'agent:kyberion/ops/worker' },
      })
    ).toThrow(/decidedBy.id must match/);
  });

  it('rejects an invalid mission id', () => {
    expect(() =>
      buildHearingMissionCreateArgs({
        missionId: 'not-a-valid-id',
        brief,
        tenantSlug: 'jisha',
        tier: 'confidential',
        decidedBy: { id: 'user:zz-hearing-member' },
      })
    ).toThrow(/HEARING_MISSION_ID_INVALID/);
  });
});
