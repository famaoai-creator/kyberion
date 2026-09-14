import { describe, expect, it } from 'vitest';
import {
  findTrainingTrack,
  loadTrainingCatalog,
  summarizeTrainingProgress,
  trainingAssignmentsPath,
  trainingProgressPath,
  type TrainingAssignment,
  type TrainingCatalog,
  type TrainingProgress,
} from './training-catalog.js';

describe('training catalog', () => {
  it('loads the three bounded learning tracks through the governed catalog', () => {
    const catalog = loadTrainingCatalog();
    expect(catalog.tracks.map((track) => track.id)).toEqual([
      'first-steps',
      'guided-work',
      'team-practice',
    ]);
    expect(findTrainingTrack('first-steps')?.lessons[0].try.kind).toBe('ask');
    expect(findTrainingTrack('first-steps')?.lessons[0].try.prefill).toBeTruthy();
  });

  it('keeps progress personal and assignments tenant-confidential', () => {
    expect(trainingProgressPath('alice')).toContain(
      'knowledge/personal/members/alice/training.json'
    );
    expect(trainingAssignmentsPath('acme-corp')).toContain(
      'knowledge/confidential/acme-corp/training/assignments.json'
    );
    expect(() => trainingProgressPath('../escape')).toThrow('invalid member id');
    expect(() => trainingAssignmentsPath('personal')).toThrow('invalid tenant slug');
  });
});

describe('summarizeTrainingProgress', () => {
  const catalog: TrainingCatalog = {
    version: '1.0.0',
    tracks: [
      {
        id: 'first-steps',
        level: 'beginner',
        title: 'First steps',
        audience: 'everyone',
        lessons: [
          {
            id: 'a',
            title: 'A',
            goal: 'a',
            try: { kind: 'ask' },
            check: { kind: 'self', text: 'a' },
          },
          {
            id: 'b',
            title: 'B',
            goal: 'b',
            try: { kind: 'ask' },
            check: { kind: 'self', text: 'b' },
          },
        ],
      },
      {
        id: 'guided-work',
        level: 'intermediate',
        title: 'Guided work',
        audience: 'everyone',
        lessons: [
          {
            id: 'c',
            title: 'C',
            goal: 'c',
            try: { kind: 'ask' },
            check: { kind: 'self', text: 'c' },
          },
        ],
      },
    ],
  };

  it('zeroes an unstarted member and keeps them in the set (keyed by progressByMember)', () => {
    const progressByMember: Record<string, TrainingProgress> = {
      alice: { version: '1.0.0', member_id: 'alice', lessons: {} },
    };
    const [summary] = summarizeTrainingProgress(catalog, [], progressByMember);
    expect(summary).toEqual({ member_id: 'alice', lessons_done: 0, lessons_total: 3 });
  });

  it('counts complete lessons across every track and reports the latest completed_at', () => {
    const progressByMember: Record<string, TrainingProgress> = {
      bob: {
        version: '1.0.0',
        member_id: 'bob',
        lessons: {
          a: { status: 'complete', completed_at: '2026-09-01T00:00:00.000Z' },
          b: { status: 'in_progress' },
          c: { status: 'complete', completed_at: '2026-09-10T00:00:00.000Z' },
        },
      },
    };
    const [summary] = summarizeTrainingProgress(catalog, [], progressByMember);
    expect(summary.lessons_done).toBe(2);
    expect(summary.lessons_total).toBe(3);
    expect(summary.last_completed_at).toBe('2026-09-10T00:00:00.000Z');
  });

  it('attaches the most recently assigned track when a member has more than one assignment', () => {
    const assignments: TrainingAssignment[] = [
      {
        member_id: 'carol',
        track_id: 'first-steps',
        status: 'complete',
        assigned_at: '2026-01-01T00:00:00.000Z',
      },
      {
        member_id: 'carol',
        track_id: 'guided-work',
        status: 'not_started',
        assigned_at: '2026-02-01T00:00:00.000Z',
      },
    ];
    const progressByMember: Record<string, TrainingProgress> = {
      carol: { version: '1.0.0', member_id: 'carol', lessons: {} },
    };
    const [summary] = summarizeTrainingProgress(catalog, assignments, progressByMember);
    expect(summary.assignment).toEqual({ track_id: 'guided-work', status: 'not_started' });
  });
});
