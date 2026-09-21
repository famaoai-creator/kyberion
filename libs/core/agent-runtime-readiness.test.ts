import { describe, expect, it, vi } from 'vitest';
import {
  classifyAgentReadiness,
  describeAgentReadiness,
  waitForAgentReadiness,
} from './agent-runtime-readiness.js';

/** The screen that cost ten minutes of dispatch waiting. */
const TRUST_PROMPT = `
Accessing workspace:

/Volumes/data/forcheck/kyberion-laya

Do you trust the contents of this project?

Antigravity CLI requires permission to read, edit, and execute files here.

> Yes, I trust this folder
  No, exit
`;


/**
 * Real idle panes, captured from a mission's prewarm on 2026-09-21. The first
 * version of the ready signatures was written without looking at one and
 * classified all three of these as `starting`.
 */
const REAL_AGY_READY = "\n\n\n\n\n\n\n  Antigravity CLI 1.2.7\n  famaoai@gmail.com (Google AI Pro)\n  Gemini 3.8 Flash (Low)\n  /Volumes/data/forcheck/kyberion-lay\n\n─────────────────────────────────────\n>\n─────────────────────────────────────\n? for shortcuts";
const REAL_CLAUDE_READY = "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n────────────────────────────────────────────────────\n❯ \n────────────────────────────────────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for ag…";

describe('classifyAgentReadiness', () => {
  it('names the trust prompt and quotes it back', () => {
    const readiness = classifyAgentReadiness(TRUST_PROMPT);
    expect(readiness.state).toBe('awaiting_human');
    expect(readiness.signatureId).toBe('workspace_trust');
    expect(readiness.promptExcerpt).toMatch(/trust the contents/i);
    expect(readiness.reason).toMatch(/once per path/);
  });

  it.each([
    ['Please sign in to continue', 'sign_in'],
    ['First copy your one-time code: ABCD-1234', 'device_code'],
    ['Do you agree to the terms? (y/n)', 'terms_or_consent'],
    ['Update available. Would you like to update?', 'update_available'],
  ])('detects %s', (text, signature) => {
    const readiness = classifyAgentReadiness(`some banner\n${text}`);
    expect(readiness.state).toBe('awaiting_human');
    expect(readiness.signatureId).toBe(signature);
  });

  it('treats a bare yes/no affordance as a stop whatever it asks', () => {
    const readiness = classifyAgentReadiness('Proceed with the unusual thing? (y/n)');
    expect(readiness.state).toBe('awaiting_human');
    expect(readiness.signatureId).toBe('generic_confirm');
  });


  it('recognises a real idle agy pane as ready', () => {
    expect(classifyAgentReadiness(REAL_AGY_READY).state).toBe('ready');
  });

  it('recognises a real idle claude pane as ready', () => {
    expect(classifyAgentReadiness(REAL_CLAUDE_READY).state).toBe('ready');
  });

  it('does not mistake the trust prompt caret for an idle input', () => {
    // "> Yes, I trust this folder" has a caret too; it is a question, not an
    // empty input, and must stay awaiting_human.
    expect(classifyAgentReadiness(TRUST_PROMPT).state).toBe('awaiting_human');
  });

  it('recognises an agent that is accepting work', () => {
    expect(classifyAgentReadiness('agent ready\nhow can I help?').state).toBe('ready');
  });

  it('recognises an agent that is still starting', () => {
    expect(classifyAgentReadiness('Connecting to provider...').state).toBe('starting');
    expect(classifyAgentReadiness('').state).toBe('starting');
  });

  it('never calls ambiguous output ready', () => {
    // The failure this exists to stop: output exists, nothing says ready,
    // and the runtime reports success because a process is alive.
    expect(classifyAgentReadiness('some unrelated chatter').state).toBe('starting');
  });

  it('lets a prompt override an earlier ready line', () => {
    const readiness = classifyAgentReadiness(`agent ready\n${TRUST_PROMPT}`);
    expect(readiness.state).toBe('awaiting_human');
  });

  it('ignores a prompt that has scrolled out of the tail', () => {
    // Answered an hour ago; the agent is working now.
    const scrolled = `${TRUST_PROMPT}\n${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\nagent ready`;
    expect(classifyAgentReadiness(scrolled).state).toBe('ready');
  });
});

describe('waitForAgentReadiness', () => {
  it('returns as soon as a prompt appears rather than waiting out the budget', async () => {
    const started = Date.now();
    const readiness = await waitForAgentReadiness({
      readPaneText: () => TRUST_PROMPT,
      timeoutMs: 30_000,
      pollIntervalMs: 10,
    });
    expect(readiness.state).toBe('awaiting_human');
    // The whole point: a question does not answer itself.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('waits through starting output and returns ready', async () => {
    let call = 0;
    const readiness = await waitForAgentReadiness({
      readPaneText: () => (++call < 3 ? 'Loading...' : 'agent ready'),
      timeoutMs: 5_000,
      pollIntervalMs: 5,
    });
    expect(readiness.state).toBe('ready');
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it('reports unavailable rather than throwing when the pane cannot be read', async () => {
    const readiness = await waitForAgentReadiness({
      readPaneText: () => {
        throw new Error('pane is gone');
      },
      timeoutMs: 1_000,
    });
    expect(readiness.state).toBe('unavailable');
    expect(readiness.reason).toMatch(/pane is gone/);
  });

  it('gives up within its budget when nothing ever becomes ready', async () => {
    const started = Date.now();
    const readiness = await waitForAgentReadiness({
      readPaneText: () => 'Loading...',
      timeoutMs: 120,
      pollIntervalMs: 10,
    });
    expect(readiness.state).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('describeAgentReadiness', () => {
  it('reads like a request for a person, with the screen attached', () => {
    const message = describeAgentReadiness(classifyAgentReadiness(TRUST_PROMPT));
    expect(message).toMatch(/waiting for you/);
    expect(message).toMatch(/trust the contents/i);
    expect(message).toMatch(/keep failing until this is answered/);
  });

  it('passes other states through unchanged', () => {
    expect(describeAgentReadiness({ state: 'ready', reason: 'all good' })).toBe('all good');
  });
});
