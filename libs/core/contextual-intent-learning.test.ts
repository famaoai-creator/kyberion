import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeRmSync } from './secure-io.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import {
  loadContextualIntentLearningStore,
  recordContextualIntentLearning,
  writeContextualIntentLearningStoreAtPath,
} from './contextual-intent-learning.js';

describe('contextual-intent-learning', () => {
  const learningPath = pathResolver.sharedTmp('test-contextual-intent-learning.json');

  beforeEach(() => {
    process.env.KYBERION_CONTEXTUAL_INTENT_LEARNING_PATH = learningPath;
    safeRmSync(learningPath);
  });

  afterEach(() => {
    delete process.env.KYBERION_CONTEXTUAL_INTENT_LEARNING_PATH;
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

  it('rejects an external learning store path', () => {
    process.env.KYBERION_CONTEXTUAL_INTENT_LEARNING_PATH =
      '/tmp/kyberion-contextual-intent-learning.json';

    expect(() => loadContextualIntentLearningStore()).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('persists the catalog-normalized store payload', () => {
    writeContextualIntentLearningStoreAtPath(learningPath, {
      version: '1.0.0',
      entries: [],
      $schema: 'https://example.test/schema.json',
    } as unknown as Parameters<typeof writeContextualIntentLearningStoreAtPath>[1]);

    expect(JSON.parse(String(safeReadFile(learningPath, { encoding: 'utf8' })))).not.toHaveProperty(
      '$schema'
    );
  });
});
