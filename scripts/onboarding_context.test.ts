import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, run } from './onboarding_context.js';

describe('onboarding_context CLI', () => {
  it('routes help output through the injected printer', () => {
    const output: unknown[] = [];

    run(['help'], (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('Onboarding context binding');
  });

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

  it('parses an explicit service context for service-shaped first work', () => {
    const parsed = parseArgs([
      'first-work',
      '--customer-slug',
      'acme-ai',
      '--intent',
      'Operate the customer service',
      '--service-id',
      'customer-operations',
    ]);
    expect(parsed.serviceId).toBe('customer-operations');
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
