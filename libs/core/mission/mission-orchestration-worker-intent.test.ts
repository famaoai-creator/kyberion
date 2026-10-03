import { beforeEach, describe, expect, it, vi } from 'vitest';

// The worker snapshot emitters read canonical intent synchronously from
// mission state and write through emitIntentSnapshot — mock both boundaries.
vi.mock('../intent/intent-snapshot-store.js', () => ({
  emitIntentSnapshot: vi.fn(),
  mapStageToLoopPhase: vi.fn((stage: string) => stage),
}));
vi.mock('./mission-intent-delta.js', () => ({
  evaluateMissionIntentDrift: vi.fn(() => null),
  missionCanonicalIntent: vi.fn(() => null),
}));
vi.mock('../intent/intent-extractor.js', () => ({
  getIntentExtractor: vi.fn(),
}));

import { emitIntentSnapshot } from '../intent/intent-snapshot-store.js';
import { getIntentExtractor, type IntentExtractor } from '../intent/intent-extractor.js';
import { missionCanonicalIntent } from './mission-intent-delta.js';
import type { SlackPayload } from './mission-orchestration-worker-contracts.js';
import {
  emitWorkerKickoffSnapshot,
  emitWorkerTransitionSnapshot,
} from './mission-orchestration-worker-part-context.js';

describe('worker intent snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(missionCanonicalIntent).mockReturnValue(null);
  });

  it('records canonical intent for stage transitions when mission state carries it', () => {
    // Regression: transition markers like 'Mission X reconciling outcomes'
    // were written as the snapshot goal; the drift gate then compared the
    // origin against activity text and manufactured a blocking verdict.
    vi.mocked(missionCanonicalIntent).mockReturnValue({
      goal: 'ship the checkout redesign',
      constraints: ['no new surfaces'],
    });

    emitWorkerTransitionSnapshot('MSN-W1', 'verification', 'Mission MSN-W1 reconciling outcomes');

    expect(emitIntentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-W1',
        stage: 'verification',
        source: 'worker_transition',
        intent: { goal: 'ship the checkout redesign', constraints: ['no new surfaces'] },
      })
    );
  });

  it('falls back to the goal hint when no canonical intent exists', () => {
    emitWorkerTransitionSnapshot('MSN-W2', 'execution', 'Mission MSN-W2 follow-up dispatched');

    expect(emitIntentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: { goal: 'Mission MSN-W2 follow-up dispatched' },
      })
    );
  });

  it('uses canonical intent for the kickoff origin instead of the extractor', async () => {
    // An LLM-extracted origin (paraphrase + invented fields) compared against
    // canonical snapshots manufactured drift on every orchestrated mission.
    const extract = vi.fn(async () => ({ goal: 'paraphrased' }));
    vi.mocked(getIntentExtractor).mockReturnValue({
      name: 'fake',
      extract,
    } as unknown as IntentExtractor);
    vi.mocked(missionCanonicalIntent).mockReturnValue({ goal: 'user stated goal' });

    await emitWorkerKickoffSnapshot('MSN-W3', {
      text: 'user stated goal',
    } as unknown as SlackPayload);

    expect(extract).not.toHaveBeenCalled();
    expect(emitIntentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-W3',
        stage: 'intake',
        source: 'user_prompt',
        intent: { goal: 'user stated goal' },
      })
    );
  });

  it('keeps the extractor path for kickoff when mission state has no intent', async () => {
    const extract = vi.fn(async () => ({ goal: 'extracted goal' }));
    vi.mocked(getIntentExtractor).mockReturnValue({
      name: 'fake',
      extract,
    } as unknown as IntentExtractor);

    await emitWorkerKickoffSnapshot('MSN-W4', {
      text: 'build something',
    } as unknown as SlackPayload);

    expect(extract).toHaveBeenCalledWith({ text: 'build something' });
    expect(emitIntentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ intent: { goal: 'extracted goal' } })
    );
  });
});
