import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import { loadContextualIntentLearningStore, recordContextualIntentLearning } from './contextual-intent-learning.js';

describe('contextual-intent-learning', () => {
  const learningPath = pathResolver.sharedTmp('test-contextual-intent-learning.json');

  beforeEach(() => {
    process.env.KYBERION_CONTEXTUAL_INTENT_LEARNING_PATH = learningPath;
    safeRmSync(learningPath);
  });

  it('records a confirmed learning observation for schedule read intent', () => {
    const frame = buildContextualIntentFrame('来週の予定教えて');
    const entry = recordContextualIntentLearning({
      utterance: '来週の予定教えて',
      intentId: 'schedule-read-agenda',
      frame,
      confirmed: true,
      tier: 'personal',
      responseShape: 'calendar_agenda_summary',
    });

    expect(entry.intent_id).toBe('schedule-read-agenda');
    expect(entry.confirmed).toBe(true);

    const store = loadContextualIntentLearningStore();
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].source_binding).toBe(frame.source_binding.selected);
  });
});
