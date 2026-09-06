import { describe, expect, it } from 'vitest';
import { hearingSessionOp, tutorSessionOp } from './meeting-guided-dialogue.js';

function fakeBackend(responses: string[]): any {
  let index = 0;
  return {
    name: 'fake-test',
    delegateTask: async () => {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
  };
}

describe('hearingSessionOp', () => {
  it('produces a question script when no answers exist yet', async () => {
    const backend = fakeBackend([
      JSON.stringify({
        questions: [
          { question: 'What problem hurts most?', purpose: 'pain', follow_ups: ['Since when?'] },
        ],
      }),
    ]);
    const result = await hearingSessionOp({ topic: 'Renewal' }, backend as never);
    expect(result.phase).toBe('script');
    expect((result.questions as Array<{ question: string }>)[0]?.question).toContain('hurts');
  });

  it('extracts requirements from answers', async () => {
    const backend = fakeBackend([
      JSON.stringify({
        requirements: [{ id: 'R1', statement: 'Export CSV monthly', priority: 'must' }],
        open_questions: ['Who approves?'],
      }),
    ]);
    const result = await hearingSessionOp(
      {
        topic: 'Renewal',
        answers: [{ question: 'What do you need?', answer: 'Monthly CSV export' }],
      },
      backend as never
    );
    expect(result.phase).toBe('results');
    expect((result.requirements as Array<{ id: string }>)[0]?.id).toBe('R1');
    expect(result.open_questions).toEqual(['Who approves?']);
  });

  it('rejects empty topics and invalid model output', async () => {
    await expect(hearingSessionOp({ topic: '  ' }, fakeBackend(['{}']) as never)).rejects.toThrow(
      /topic is required/
    );
    await expect(
      hearingSessionOp({ topic: 'T' }, fakeBackend(['no json']) as never)
    ).rejects.toThrow(/no JSON block/);
  });
});

describe('tutorSessionOp', () => {
  it('explains gently with checks when no answers exist yet', async () => {
    const backend = fakeBackend([
      JSON.stringify({
        sections: [{ heading: 'Light', body: 'Plants eat light, kindly speaking.' }],
        checks: [{ question: 'What do plants eat?', expected_points: ['light'] }],
      }),
    ]);
    const result = await tutorSessionOp({ material: 'Photosynthesis.' }, backend as never);
    expect(result.phase).toBe('lesson');
    expect((result.sections as Array<{ heading: string }>)[0]?.heading).toBe('Light');
  });

  it('grades answers kindly with follow-up steps', async () => {
    const backend = fakeBackend([
      JSON.stringify({
        mastery: 'progressing',
        feedback: 'Good start!',
        corrections: ['Light, not water, is the energy source.'],
        follow_up: ['Re-read section 1'],
      }),
    ]);
    const result = await tutorSessionOp(
      {
        material: 'Photosynthesis.',
        answers: [{ question: 'What do plants eat?', answer: 'Light, I think' }],
      },
      backend as never
    );
    expect(result.phase).toBe('feedback');
    expect(result.mastery).toBe('progressing');
  });
});
