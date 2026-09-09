import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { schemaHint } from './structured-schema-hint.js';

describe('structured-schema-hint', () => {
  it('describes object and array shapes', () => {
    const hint = schemaHint(
      z.object({
        answer: z.string(),
        items: z.array(z.object({ id: z.string() })),
      })
    );
    expect(hint).toContain('answer: string');
    expect(hint).toContain('items: array of');
    expect(hint).toContain('id: string');
  });
});
