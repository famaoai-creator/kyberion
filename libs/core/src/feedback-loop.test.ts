import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractHintsFromTrace, persistHints } from './feedback-loop.js';
import type { Trace } from './trace.js';

const PUBLIC_HINTS = path.resolve(process.cwd(), 'knowledge/public/procedures/hints/auto-learned.json');
const RUNTIME_HINTS_DIR = path.resolve(process.cwd(), 'active/shared/runtime/feedback-loop/hints');
const RUNTIME_HINTS = path.join(RUNTIME_HINTS_DIR, 'auto-learned.json');

function makeTrace(): Trace {
  return {
    traceId: 'trace-123',
    metadata: {
      actuator: 'browser-actuator',
      startedAt: '2026-03-25T00:00:00.000Z',
      completedAt: '2026-03-25T00:01:00.000Z',
    },
    rootSpan: {
      spanId: 'root',
      name: 'browser-pipeline',
      startTime: '2026-03-25T00:00:00.000Z',
      endTime: '2026-03-25T00:01:00.000Z',
      status: 'error',
      events: [],
      artifacts: [],
      knowledgeRefs: [],
      children: [
        {
          spanId: 'child',
          name: 'capture:screenshot',
          startTime: '2026-03-25T00:00:05.000Z',
          endTime: '2026-03-25T00:00:10.000Z',
          status: 'error',
          error: 'Failed to open /Users/example/secret.txt from active/shared/tmp/demo.png',
          events: [],
          artifacts: [
            {
              type: 'screenshot',
              path: 'active/shared/tmp/demo.png',
              timestamp: '2026-03-25T00:00:08.000Z',
            },
          ],
          knowledgeRefs: [],
          children: [],
        },
      ],
    },
  };
}

describe('feedback-loop', () => {
  beforeEach(() => {
    fs.rmSync(RUNTIME_HINTS_DIR, { recursive: true, force: true });
    if (fs.existsSync(PUBLIC_HINTS)) {
      fs.unlinkSync(PUBLIC_HINTS);
    }
  });

  afterEach(() => {
    fs.rmSync(RUNTIME_HINTS_DIR, { recursive: true, force: true });
    if (fs.existsSync(PUBLIC_HINTS)) {
      fs.unlinkSync(PUBLIC_HINTS);
    }
  });

  it('sanitizes trace-derived hints so they do not expose raw paths', () => {
    const hints = extractHintsFromTrace(makeTrace());

    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((hint) => hint.hint.includes('/Users/example/secret.txt'))).toBe(false);
    expect(hints.some((hint) => hint.hint.includes('active/shared/tmp/demo.png'))).toBe(false);
  });

  it('persists generated hints under governed runtime paths, not public knowledge', () => {
    persistHints([
      {
        topic: 'error capture screenshot',
        hint: 'Review trace trace-123 for details.',
        source: 'trace/trace-123',
        confidence: 0.7,
        tags: ['auto-generated'],
      },
    ]);

    expect(fs.existsSync(RUNTIME_HINTS)).toBe(true);
    expect(fs.existsSync(PUBLIC_HINTS)).toBe(false);
  });
});
