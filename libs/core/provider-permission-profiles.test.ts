import { afterEach, describe, expect, it } from 'vitest';
import {
  PROVIDER_IDS,
  buildProviderChildEnv,
  resolveProviderPermissionArgs,
  type ProviderId,
} from './provider-permission-profiles.js';
import { listSubagentCapabilityProfileNames } from './subagent-capability-profiles.js';

describe('provider-permission-profiles', () => {
  describe('resolveProviderPermissionArgs', () => {
    it('resolves every KD-05 profile x provider combo to either a grant or a typed refusal, never throwing', () => {
      for (const profileName of listSubagentCapabilityProfileNames()) {
        for (const provider of PROVIDER_IDS) {
          let resolution: ReturnType<typeof resolveProviderPermissionArgs> | undefined;
          expect(() => {
            resolution = resolveProviderPermissionArgs(profileName, provider);
          }).not.toThrow();
          expect(resolution).toBeDefined();
          expect(['ok', 'refused']).toContain(resolution!.kind);
          if (resolution!.kind === 'ok') {
            expect(Array.isArray(resolution!.args)).toBe(true);
          } else {
            expect(typeof resolution!.reason).toBe('string');
            expect(resolution!.reason.length).toBeGreaterThan(0);
          }
        }
      }
    });

    it('throws only for a genuinely unknown KD-05 tier name', () => {
      expect(() => resolveProviderPermissionArgs('not-a-real-tier', 'claude')).toThrow(
        /SUBAGENT_PROFILE_UNKNOWN/
      );
    });

    it('grants explorer no write/exec permissions for any provider', () => {
      // Full-access markers that would indicate explorer was granted
      // write/exec capability. Individual write/exec tool NAMES (e.g.
      // "Write") legitimately appear in claude's --disallowedTools list, so
      // those are checked separately by asserting the allowedTools segment
      // only contains read-only tools.
      const grantMarkers = [
        'workspace-write',
        'bypassPermissions',
        '--dangerously-skip-permissions',
      ];
      const writeExecToolNames = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'KillShell'];

      for (const provider of PROVIDER_IDS) {
        const resolution = resolveProviderPermissionArgs('explorer', provider);
        if (resolution.kind === 'refused') {
          // Refusing delegation is itself "no write/exec permission granted."
          continue;
        }
        for (const marker of grantMarkers) {
          expect(resolution.args).not.toContain(marker);
        }

        const allowedToolsIndex = resolution.args.indexOf('--allowedTools');
        if (allowedToolsIndex !== -1) {
          const nextFlagIndex = resolution.args.findIndex(
            (arg, i) => i > allowedToolsIndex && arg.startsWith('--')
          );
          const allowedToolsSegment = resolution.args.slice(
            allowedToolsIndex + 1,
            nextFlagIndex === -1 ? undefined : nextFlagIndex
          );
          for (const toolName of writeExecToolNames) {
            expect(allowedToolsSegment).not.toContain(toolName);
          }
        }
      }
    });

    it('grants planner no write/exec permissions for any provider (grant or refusal)', () => {
      for (const provider of PROVIDER_IDS) {
        const resolution = resolveProviderPermissionArgs('planner', provider);
        if (resolution.kind === 'ok') {
          expect(resolution.args).not.toContain('workspace-write');
          expect(resolution.args).not.toContain('bypassPermissions');
        } else {
          expect(resolution.reason.length).toBeGreaterThan(0);
        }
      }
    });

    it('grants implementer at least one permission arg for every provider', () => {
      for (const provider of PROVIDER_IDS) {
        const resolution = resolveProviderPermissionArgs('implementer', provider);
        expect(resolution.kind).toBe('ok');
        if (resolution.kind === 'ok') {
          expect(resolution.args.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('buildProviderChildEnv', () => {
    const providers: ProviderId[] = ['claude', 'codex', 'agy'];
    const fakeBaseEnv = (): NodeJS.ProcessEnv =>
      ({
        PATH: '/usr/bin:/bin',
        HOME: '/home/test',
        LANG: 'en_US.UTF-8',
        TERM: 'xterm',
        OPENAI_API_KEY: 'fake-openai-key',
        ANTHROPIC_API_KEY: 'fake-anthropic-key',
        GEMINI_API_KEY: 'fake-gemini-key',
        GH_TOKEN: 'fake-github-token',
        CUSTOM_SECRET_TOKEN: 'fake-custom-token',
        CODEX_HOME: '/home/test/.codex',
        KYBERION_PERSONA: 'implementer',
        MISSION_ID: 'MSN-1',
        UNRELATED_VAR: 'should-not-leak',
      }) as NodeJS.ProcessEnv;

    afterEach(() => {
      delete process.env.KYBERION_PROVIDER_ENV_ALLOWLIST;
    });

    it('always allowlists PATH/HOME/LANG/TERM', () => {
      for (const provider of providers) {
        const env = buildProviderChildEnv({ provider, baseEnv: fakeBaseEnv() });
        expect(env.PATH).toBe('/usr/bin:/bin');
        expect(env.HOME).toBe('/home/test');
        expect(env.LANG).toBe('en_US.UTF-8');
        expect(env.TERM).toBe('xterm');
      }
    });

    it('excludes other providers credentials for claude', () => {
      const env = buildProviderChildEnv({ provider: 'claude', baseEnv: fakeBaseEnv() });
      expect(env.ANTHROPIC_API_KEY).toBe('fake-anthropic-key');
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.CUSTOM_SECRET_TOKEN).toBeUndefined();
    });

    it('excludes other providers credentials for codex, and carries CODEX_HOME', () => {
      const env = buildProviderChildEnv({ provider: 'codex', baseEnv: fakeBaseEnv() });
      expect(env.OPENAI_API_KEY).toBe('fake-openai-key');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.CODEX_HOME).toBe('/home/test/.codex');
    });

    it('excludes all credential vars for agy (no declared credential var)', () => {
      const env = buildProviderChildEnv({ provider: 'agy', baseEnv: fakeBaseEnv() });
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
    });

    it('carries KYBERION_*/MISSION_* vars for every provider, but not unrelated vars', () => {
      for (const provider of providers) {
        const env = buildProviderChildEnv({ provider, baseEnv: fakeBaseEnv() });
        expect(env.KYBERION_PERSONA).toBe('implementer');
        expect(env.MISSION_ID).toBe('MSN-1');
        expect(env.UNRELATED_VAR).toBeUndefined();
      }
    });

    it('escape hatch KYBERION_PROVIDER_ENV_ALLOWLIST=0 returns baseEnv unchanged', () => {
      const base = { ...fakeBaseEnv(), KYBERION_PROVIDER_ENV_ALLOWLIST: '0' } as NodeJS.ProcessEnv;
      const env = buildProviderChildEnv({ provider: 'claude', baseEnv: base });
      expect(env).toEqual(base);
      expect(env.OPENAI_API_KEY).toBe('fake-openai-key');
      expect(env.UNRELATED_VAR).toBe('should-not-leak');
    });

    it('defaults to process.env when baseEnv is omitted', () => {
      const previous = process.env.KYBERION_TEST_MARKER;
      process.env.KYBERION_TEST_MARKER = 'present';
      try {
        const env = buildProviderChildEnv({ provider: 'claude' });
        expect(env.KYBERION_TEST_MARKER).toBe('present');
      } finally {
        if (previous === undefined) delete process.env.KYBERION_TEST_MARKER;
        else process.env.KYBERION_TEST_MARKER = previous;
      }
    });
  });
});
