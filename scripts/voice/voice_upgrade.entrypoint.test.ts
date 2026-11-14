import { describe, expect, it } from 'vitest';
import { parseVoiceUpgradeArgs } from './voice_upgrade.js';

describe('voice upgrade entrypoint', () => {
  it('maps explicit subcommands to tiers', () => {
    expect(parseVoiceUpgradeArgs(['cloud'])).toEqual({ tier: 1, help: false });
    expect(parseVoiceUpgradeArgs(['local'])).toEqual({ tier: 2, help: false });
    expect(parseVoiceUpgradeArgs(['--tier', '0'])).toEqual({ tier: 0, help: false });
  });

  it('rejects ambiguous or unknown targets', () => {
    expect(() => parseVoiceUpgradeArgs(['cloud', 'local'])).toThrow(
      'voice upgrade target was specified more than once'
    );
    expect(() => parseVoiceUpgradeArgs(['--dry-run'])).toThrow("unknown option '--dry-run'");
  });

  it('returns help without selecting a tier', () => {
    expect(parseVoiceUpgradeArgs(['--help'])).toEqual({ help: true });
  });
});
