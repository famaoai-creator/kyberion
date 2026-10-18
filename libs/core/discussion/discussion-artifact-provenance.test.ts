import { describe, expect, it } from 'vitest';
import { reduceDiscussionRoom } from './discussion-reducer.js';
import { renderDiscussionBriefHtml } from './discussion-brief.js';
import { renderDiscussionMinutes } from './discussion-outcomes.js';
import type { DiscussionExecution } from './discussion-types.js';

function fixture() {
  const room = reduceDiscussionRoom('disc-provenance', []);
  room.title = 'Compare options';
  room.goal = 'Prepare a draft';
  room.config.locale = 'en';
  room.decision = {
    type: 'decision',
    seq: 1,
    ts: '2026-10-18T00:00:00Z',
    summary: 'Tentatively choose A',
    agreements: [],
    dissent: [],
    next_steps: [],
    consensus: 1,
    concluded_by: 'facilitator',
  };
  return room;
}

const execution = () =>
  ({
    requested_mode: 'reasoning',
    actual_mode: 'reasoning',
    requested_provider: 'codex',
    provider: 'codex',
    model: null,
    call_budget: 1,
    timeout_ms: 60000,
    internal_turn_limit: null,
    attempts: [
      {
        id: 'call-1',
        operation: 'decision',
        provider: 'codex',
        status: 'succeeded',
        started_at: '2026-10-18T00:00:00Z',
        finished_at: '2026-10-18T00:00:01Z',
      },
    ],
  }) as DiscussionExecution;

describe('visible artifact execution provenance', () => {
  it('labels legacy provenance unknown rather than implying a real call', () => {
    const room = fixture();
    for (const text of [
      renderDiscussionMinutes(room),
      renderDiscussionBriefHtml(room, { mode: 'view' }),
    ]) {
      expect(text).toContain('Execution provenance is unavailable');
      expect(text).toContain('Unknown / unverified');
      expect(text).toContain('Unknown (not reported by the transport)');
    }
  });
  it('labels scripted artifacts as illustrations with no model invoked', () => {
    const room = fixture();
    room.execution = {
      ...execution(),
      requested_mode: 'scripted',
      actual_mode: 'scripted',
      requested_provider: null,
      provider: null,
      call_budget: 0,
      attempts: [],
    };
    for (const text of [
      renderDiscussionMinutes(room),
      renderDiscussionBriefHtml(room, { mode: 'view' }),
    ]) {
      expect(text).toContain('Scripted demonstration. No model was called');
      expect(text).toContain('0 / 0');
    }
  });
  it('shows single-model limits, requested/observed provider, unknown model and budget in saved bytes', () => {
    const room = fixture();
    room.config.single_pass = true;
    room.execution = execution();
    for (const text of [
      renderDiscussionMinutes(room),
      renderDiscussionBriefHtml(room, { mode: 'view' }),
      renderDiscussionBriefHtml(room, { mode: 'review' }),
    ]) {
      expect(text).toContain('Tentative single-model brief');
      expect(text).toContain('No panel deliberation or independent evidence verification');
      expect(text).toContain('Requested provider');
      expect(text).toContain('Observed provider');
      expect(text).toContain('codex');
      expect(text).toContain('Unknown (not reported by the transport)');
      expect(text).toContain('1 / 1');
      expect(text).not.toContain('Consensus trend');
      expect(text).not.toContain('Consensus 100%');
    }
    expect(renderDiscussionBriefHtml(room, { mode: 'view' })).not.toContain('data-verdict=');
    expect(renderDiscussionBriefHtml(room, { mode: 'review' })).toContain('data-verdict="accept"');
  });
});
