import { describe, expect, it } from 'vitest';
import { planNarrationTimeline } from './video-narration-timeline.js';

describe('narration timeline', () => {
  it('sizes each scene from its measured narration plus lead and hold', () => {
    const plan = planNarrationTimeline([
      { scene_id: 'hook', narration_sec: 4 },
      { scene_id: 'logo', narration_sec: 2, min_sec: 6 },
      { scene_id: 'silent' },
    ]);
    expect(plan.scenes).toEqual([
      {
        scene_id: 'hook',
        start_sec: 0,
        duration_sec: 5.5,
        narration_sec: 4,
        narration_offset_sec: 0.6,
      },
      {
        scene_id: 'logo',
        start_sec: 5.5,
        duration_sec: 6,
        narration_sec: 2,
        narration_offset_sec: 6.1,
      },
      {
        scene_id: 'silent',
        start_sec: 11.5,
        duration_sec: 3,
        narration_sec: 0,
        narration_offset_sec: 11.5,
      },
    ]);
    expect(plan.total_duration_sec).toBe(14.5);
  });

  it('honours custom lead and tail', () => {
    const plan = planNarrationTimeline([{ scene_id: 'a', narration_sec: 3 }], {
      lead_sec: 0.2,
      tail_sec: 0.3,
    });
    expect(plan.scenes[0]).toMatchObject({ duration_sec: 3.5, narration_offset_sec: 0.2 });
  });
});
