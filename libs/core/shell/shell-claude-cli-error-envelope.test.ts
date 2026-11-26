import { describe, expect, it } from 'vitest';
import { describeClaudeCliErrorEnvelope } from './shell-claude-cli-backend.js';
import { classifyReasoningFailure } from '../reasoning/reasoning-failure-taxonomy.js';

describe('describeClaudeCliErrorEnvelope', () => {
  it('extracts the result of an is_error JSON envelope', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Invalid API key · Please run /login',
    });
    expect(describeClaudeCliErrorEnvelope(stdout)).toBe('Invalid API key · Please run /login');
  });

  it('reads the final record of a multi-line stream', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached' }),
    ].join('\n');
    expect(describeClaudeCliErrorEnvelope(stdout)).toBe('Claude AI usage limit reached');
  });

  it('never surfaces non-error output', () => {
    expect(describeClaudeCliErrorEnvelope('')).toBe('');
    expect(describeClaudeCliErrorEnvelope('plain text')).toBe('');
    expect(
      describeClaudeCliErrorEnvelope(
        JSON.stringify({ type: 'result', is_error: false, result: 'secret answer' })
      )
    ).toBe('');
  });

  it('lets the failure taxonomy classify what used to be an empty-stderr `unknown`', () => {
    const before = new Error('[shell-claude-cli] CLI exited with code 1. stderr: ');
    const after = new Error(
      `[shell-claude-cli] CLI exited with code 1. stderr: . result: ${describeClaudeCliErrorEnvelope(
        JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'Invalid API key · Please run /login',
        })
      )}`
    );
    expect(classifyReasoningFailure(before).class).toBe('unknown');
    expect(classifyReasoningFailure(after).class).toBe('auth');
  });
});
