import { describe, expect, it, vi } from 'vitest';
import { main } from './onboarding.js';

describe('onboarding facade', () => {
  it('routes company onboarding without entering the interactive wizard', async () => {
    const print = vi.fn();

    await main(
      [
        'company',
        '--vertical',
        'saas-product-company',
        '--slug',
        'review-company',
        '--name',
        'Review Company',
        '--goal',
        'Validate the onboarding facade',
        '--dry-run',
      ],
      print
    );

    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'planned', writtenFiles: [] })
    );
  });

  it('routes company bootstrap list through the same namespace', async () => {
    const print = vi.fn();

    await main(['company', 'bootstrap', '--list'], print);

    expect(print).toHaveBeenCalledWith(expect.stringContaining('Available company verticals:'));
  });

  it('routes the non-interactive apply path through the same namespace', async () => {
    await expect(
      main([
        'apply',
        '--identity',
        'active/shared/tmp/missing-onboarding-identity.json',
        '--dry-run',
      ])
    ).rejects.toThrow('identity file not found');
  });

  it('keeps reset preview output on the facade printer', async () => {
    const print = vi.fn();

    await main(['reset', '--dry-run', '--json'], print);

    expect(print).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });
});
