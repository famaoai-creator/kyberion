import { describe, expect, it } from 'vitest';
import { classifyOrganizationWork } from '../organization/organization-operating-model-persistence.js';
import { shouldCompileSurfaceIntent } from '../surface/surface-runtime-router.js';
import type { SurfaceConversationInput } from '../surface/channel-surface-types.js';
import expected from './resolver-adapter-characterization.fixture.json';

/*
 * Characterization of the per-surface routing special cases and the
 * organization-work regex classifier (R3 of the intent resolver unification
 * plan). The table was recorded from the code before R3 moved both into the
 * resolver entry (routing-decision.ts) and must stay identical after it.
 */

function surfaceFor(agentId: string): string {
  if (agentId === 'slack-surface-agent') return 'slack';
  if (agentId === 'presence-surface-agent') return 'presence';
  return 'cli';
}

describe('resolver adapter characterization (recorded before R3)', () => {
  it('classifies organization work exactly as before', () => {
    for (const row of expected.organization) {
      const taskKind = (row as { selected_task_kind?: string }).selected_task_kind;
      expect(classifyOrganizationWork(row.utterance, taskKind), row.utterance).toEqual(row.result);
    }
  });

  it('decides surface compilation exactly as before', () => {
    for (const row of expected.surface as Array<{
      agent_id: string;
      receiver?: string;
      mission_handoff?: boolean;
      text: string;
      compile: boolean;
    }>) {
      const input = {
        surface: surfaceFor(row.agent_id),
        query: row.text,
        senderAgentId: 'test-surface',
        agentId: row.agent_id,
        ...(row.mission_handoff ? { missionId: 'MSN-X', teamRole: 'implementer' } : {}),
      } as unknown as SurfaceConversationInput;
      expect(
        shouldCompileSurfaceIntent(
          input,
          `Current incoming message:\n${row.text}`,
          row.receiver as 'chronos-mirror' | undefined
        ),
        `${row.agent_id} ${row.receiver ?? '-'} ${row.text}`
      ).toBe(row.compile);
    }
  });
});
