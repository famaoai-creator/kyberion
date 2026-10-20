import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import { loadDotExecutionPolicy } from './dot-execution-policy.js';
import { dotLearnedFloorHolds } from './dot-autonomy.js';
import type { DotFeedbackEntry } from './dot-feedback.js';

const fixture = pathResolver.sharedTmp('dot-policy-tests/policy.json');
const knowledge = pathResolver.knowledge;
afterEach(() => {
  vi.restoreAllMocks();
  safeRmSync(pathResolver.sharedTmp('dot-policy-tests'), { recursive: true, force: true });
});
function configure(value: unknown) {
  safeWriteFile(fixture, JSON.stringify(value));
  vi.spyOn(pathResolver, 'knowledge').mockImplementation((...args) =>
    args[0] === 'product/governance/dot-execution-policy.json' ? fixture : knowledge(...args)
  );
}
describe('governed Dot execution policy', () => {
  it('loads fanout, shape and learned-floor conditions from validated data', () => {
    const base = loadDotExecutionPolicy();
    configure({
      ...base,
      intake: { ...base.intake, max_proposals_per_wake: 2, allowed_work_shapes: ['mission'] },
      learning: { ...base.learning, l2_release_approvals: 1 },
    });
    expect(loadDotExecutionPolicy().intake).toMatchObject({
      max_proposals_per_wake: 2,
      allowed_work_shapes: ['mission'],
    });
    const feedback = [
      { outcome: 'rejected', recorded_at: '2026-10-01T00:00:00Z' },
      {
        outcome: 'approved',
        decided_by_type: 'human',
        decided_by: 'user:owner',
        recorded_at: '2026-10-01T01:00:00Z',
      },
    ] as DotFeedbackEntry[];
    expect(dotLearnedFloorHolds(feedback, 'L2', new Date('2026-10-01T02:00:00Z'))).toBe(false);
  });
  it('invalid or unknown policy fields disable admission and learning relaxation', () => {
    configure({ ...loadDotExecutionPolicy(), allow_all: true });
    expect(loadDotExecutionPolicy().intake.enabled).toBe(false);
    expect(loadDotExecutionPolicy().learning.enabled).toBe(false);
  });
});
