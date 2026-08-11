import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './onboarding_context.js';

describe('onboarding_context CLI', () => {
  it('defaults binding writes to dry-run and parses first-work acceptance', () => {
    const parsed = parseArgs([
      'first-work',
      '--customer-slug',
      'acme-ai',
      '--intent',
      'Build a new customer portal',
      '--apply',
      '--accept',
      '--bootstrap-project',
    ]);
    expect(parsed.command).toBe('first-work');
    expect(parsed.apply).toBe(true);
    expect(parsed.accept).toBe(true);
    expect(parsed.bootstrapProject).toBe(true);
  });

  it('keeps bind in dry-run unless apply is explicit', () => {
    const parsed = parseArgs(['bind', '--customer-slug', 'acme-ai', '--tenant-slug', 'acme-prod']);
    expect(parsed.command).toBe('bind');
    expect(parsed.apply).toBe(false);
  });

  it('resolves an explicit root directory for hermetic execution', () => {
    const parsed = parseArgs(['show', '--root-dir', './fixture-root', '--json']);
    expect(parsed.rootDir).toBe(path.resolve('./fixture-root'));
  });
});
