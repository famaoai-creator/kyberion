import { describe, expect, it, vi } from 'vitest';
import {
  parseStructuredJson,
  runStructuredReasoningOp,
  structuredReasoningSpecs,
} from './structured-reasoning.js';

describe('parseStructuredJson', () => {
  it('parses a clean JSON object', () => {
    expect(parseStructuredJson('{"a":1}', 'x')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in ```json fences', () => {
    const text = 'Here you go:\n```json\n{"a":2}\n```\nDone.';
    expect(parseStructuredJson(text, 'x')).toEqual({ a: 2 });
  });

  it('parses a JSON object embedded in surrounding prose', () => {
    expect(parseStructuredJson('Result: {"a":3} hope that helps', 'x')).toEqual({ a: 3 });
  });

  it('parses a top-level JSON array', () => {
    expect(parseStructuredJson('[{"id":"1"}]', 'x')).toEqual([{ id: '1' }]);
  });

  it('throws on empty or unparseable text', () => {
    expect(() => parseStructuredJson('   ', 'op1')).toThrow(/empty response/);
    expect(() => parseStructuredJson('not json at all', 'op2')).toThrow(/failed to parse JSON for op "op2"/);
  });
});

describe('runStructuredReasoningOp', () => {
  it('divergePersonas extracts the hypotheses array', async () => {
    const complete = vi.fn(async () => '{"hypotheses":[{"id":"h1","proposed_by":"cfo","content":"c"}]}');
    const out = await runStructuredReasoningOp(
      structuredReasoningSpecs.divergePersonas,
      { topic: 'pricing', personas: ['cfo', 'cto'], minPerPersona: 2 } as any,
      complete,
    );
    expect(out).toEqual([{ id: 'h1', proposed_by: 'cfo', content: 'c' }]);
    // system prompt + a user prompt carrying the topic were passed
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1]).toContain('Topic: pricing');
  });

  it('extractRequirements validates and returns the whole object (with defaults)', async () => {
    const complete = vi.fn(
      async () => '```json\n{"functional_requirements":[{"id":"FR-1","description":"d","priority":"must"}]}\n```',
    );
    const out: any = await runStructuredReasoningOp(
      structuredReasoningSpecs.extractRequirements,
      { sourceText: 'transcript' } as any,
      complete,
    );
    expect(out.functional_requirements[0].id).toBe('FR-1');
    expect(out.non_functional_requirements).toEqual([]); // schema default applied
  });

  it('throws a descriptive error when the model output fails schema validation', async () => {
    const complete = vi.fn(async () => '{"hypotheses":[{"id":123}]}'); // id must be string + missing fields
    await expect(
      runStructuredReasoningOp(
        structuredReasoningSpecs.divergePersonas,
        { topic: 't', personas: ['a'] } as any,
        complete,
      ),
    ).rejects.toThrow(/schema validation failed for "divergePersonas"/);
  });
});
