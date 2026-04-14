import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { getPresenceAvatarProfile, resetPresenceAvatarRegistryCache } from './presence-avatar.js';

describe('presence-avatar registry', () => {
  const tmpDir = pathResolver.sharedTmp('presence-avatar-tests');
  const overridePath = `${tmpDir}/avatar-profiles.json`;

  afterEach(() => {
    delete process.env.KYBERION_PRESENCE_AVATAR_PROFILES_PATH;
    resetPresenceAvatarRegistryCache();
    safeRmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads profiles from the governed default registry', () => {
    const registry = JSON.parse(
      safeReadFile(pathResolver.knowledge('public/presence/avatar-profiles.json'), { encoding: 'utf8' }) as string,
    ) as {
      aliases?: Record<string, string>;
      profiles?: Array<{ agentId: string; displayName: string; defaultAvatarAssetPath: string }>;
    };
    const resolvedAgentId = registry.aliases?.['chronos-mirror'] || 'chronos-mirror';
    const expectedProfile = registry.profiles?.find((entry) => entry.agentId === resolvedAgentId);
    const profile = getPresenceAvatarProfile('chronos-mirror');

    expect(profile.displayName).toBe(expectedProfile?.displayName);
    expect(profile.defaultAvatarAssetPath).toBe(expectedProfile?.defaultAvatarAssetPath);
  });

  it('allows overriding the registry path externally', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        defaultAgentId: 'presence-surface-agent',
        aliases: {
          'custom-surface': 'presence-surface-agent',
        },
        profiles: [
          {
            agentId: 'presence-surface-agent',
            displayName: 'Custom Kyberion',
            defaultAvatarAssetPath: '/assets/custom/neutral.svg',
            expressionAvatarMap: {
              neutral: '/assets/custom/neutral.svg',
            },
          },
        ],
      }, null, 2),
    );
    process.env.KYBERION_PRESENCE_AVATAR_PROFILES_PATH = overridePath;
    resetPresenceAvatarRegistryCache();

    const profile = getPresenceAvatarProfile('custom-surface');

    expect(profile.displayName).toBe('Custom Kyberion');
    expect(profile.defaultAvatarAssetPath).toBe('/assets/custom/neutral.svg');
  });
});
