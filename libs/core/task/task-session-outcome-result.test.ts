import { describe, expect, it } from 'vitest';
import {
  createTaskSession,
  saveTaskSession,
  loadTaskSession,
  reopenTaskSession,
} from './task-session.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';

describe('Task Session Outcome Result integration', () => {
  it('persists an honest projection, regenerates it on save, and clears it on reopen', () => {
    const sessionId = `TSK-OUTCOME-${process.pid}`;
    const session = createTaskSession({
      sessionId,
      surface: 'presence',
      taskType: 'analysis',
      status: 'completed',
      goal: { summary: 'Weekly report', success_condition: 'The report file is saved.' },
    });
    session.artifact = {
      kind: 'docx',
      output_path: 'weekly.docx',
      preview_text: 'The report file is saved.',
    };
    try {
      saveTaskSession(session);
      const first = loadTaskSession(sessionId)!;
      expect(first.completion_summary?.satisfied).toBe(true);
      expect(first.completion_summary?.outcome_result).toMatchObject({
        artifacts: [{ ref: 'weekly.docx' }],
        verification: { status: 'unassessed' },
        delivery: { status: 'unknown' },
      });
      first.artifact!.output_path = 'revised.docx';
      first.completion_summary!.outcome_result!.delivery.status = 'delivered';
      saveTaskSession(first);
      expect(loadTaskSession(sessionId)?.completion_summary?.outcome_result).toMatchObject({
        artifacts: [{ ref: 'revised.docx' }],
        delivery: { status: 'unknown' },
      });
      const reopened = reopenTaskSession(sessionId, { reason: 'Revise the totals' });
      expect(reopened?.completion_summary?.outcome_result).toBeUndefined();
      expect(loadTaskSession(sessionId)?.completion_summary?.outcome_result).toBeUndefined();
    } finally {
      safeRmSync(pathResolver.shared(`runtime/task-sessions/${sessionId}.json`), { force: true });
    }
  });
});
