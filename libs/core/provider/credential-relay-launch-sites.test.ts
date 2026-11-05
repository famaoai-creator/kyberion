import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeChildEnv, withoutRelayManagedCredentials } from '../foundation/env.js';
import { sanitizeEnvForChild } from '../mesh/acp-mediator.js';
import { buildClaudeAgentIsolatedEnv, relayFailClosedEnvOption } from './claude-agent-query.js';
import {
  buildProviderChildEnv,
  providerCredentialEnvValues,
} from './provider-permission-profiles.js';

const ANTHROPIC = 'sk-ant-launch-site-real-key-0123456789';
const OPENAI = 'sk-openai-launch-site-real-key-0123456789';
const FLAG = 'KYBERION_PROVIDER_CREDENTIAL_RELAY';

const keysEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    PATH: '/bin',
    HOME: '/home/test',
    ANTHROPIC_API_KEY: ANTHROPIC,
    OPENAI_API_KEY: OPENAI,
    GEMINI_API_KEY: 'gemini-key-not-relay-managed-0123',
    ...extra,
  }) as NodeJS.ProcessEnv;

const hasRealKey = (env: Record<string, unknown>): boolean =>
  JSON.stringify(env).includes(ANTHROPIC) || JSON.stringify(env).includes(OPENAI);

afterEach(() => vi.unstubAllEnvs());

describe('relay fail-closed at launch sites that start no relay', () => {
  it('safeChildEnv (agent-adapter codex exec / claude -p, codex app-server) drops the keys only when the flag is on', () => {
    const off = safeChildEnv(keysEnv());
    expect(off.ANTHROPIC_API_KEY).toBe(ANTHROPIC);
    expect(off.OPENAI_API_KEY).toBe(OPENAI);

    const on = safeChildEnv(keysEnv({ [FLAG]: '1' }));
    expect(hasRealKey(on)).toBe(false);
    expect(on.GEMINI_API_KEY).toBe('gemini-key-not-relay-managed-0123');
  });

  it('safeChildEnv honors the flag from process.env even when the caller passes its own env', () => {
    vi.stubEnv(FLAG, '1');
    expect(hasRealKey(safeChildEnv(keysEnv()))).toBe(false);
  });

  it('ACP mediator child env drops the key only when the flag is on', () => {
    expect(sanitizeEnvForChild(keysEnv()).ANTHROPIC_API_KEY).toBe(ANTHROPIC);
    expect(hasRealKey(sanitizeEnvForChild(keysEnv({ [FLAG]: '1' })))).toBe(false);
  });

  it('claude-agent strict isolation env drops the key only when the flag is on', () => {
    expect(buildClaudeAgentIsolatedEnv(keysEnv()).ANTHROPIC_API_KEY).toBe(ANTHROPIC);
    expect(hasRealKey(buildClaudeAgentIsolatedEnv(keysEnv({ [FLAG]: '1' })))).toBe(false);
  });

  it('claude-agent non-strict queries get an explicit key-free env only when the flag is on', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ANTHROPIC);
    expect(relayFailClosedEnvOption()).toEqual({});
    vi.stubEnv(FLAG, '1');
    const option = relayFailClosedEnvOption();
    expect(option.env).toBeDefined();
    expect(hasRealKey(option.env as Record<string, unknown>)).toBe(false);
  });

  it('withoutRelayManagedCredentials returns the same object when nothing changes', () => {
    const env = { PATH: '/bin' };
    expect(withoutRelayManagedCredentials(env, { [FLAG]: '1' })).toBe(env);
  });

  it('refuses the full-inheritance escape hatch combined with the relay flag', () => {
    expect(() =>
      buildProviderChildEnv({
        provider: 'claude',
        baseEnv: keysEnv({ [FLAG]: '1', KYBERION_PROVIDER_ENV_ALLOWLIST: '0' }),
      })
    ).toThrow('[CREDENTIAL_RELAY_CONFLICT]');
    expect(
      buildProviderChildEnv({
        provider: 'claude',
        baseEnv: keysEnv({ KYBERION_PROVIDER_ENV_ALLOWLIST: '0' }),
      }).OPENAI_API_KEY
    ).toBe(OPENAI);
  });
});

describe('output redaction needles', () => {
  it('include copilot and GitHub token values', () => {
    const values = providerCredentialEnvValues({
      COPILOT_PROVIDER_API_KEY: 'copilot-provider-key-0123',
      GH_TOKEN: 'ghp_launchsitetoken0123',
      GITHUB_TOKEN: 'github-token-value-0123',
    } as NodeJS.ProcessEnv);
    expect(values).toEqual(
      expect.arrayContaining([
        'copilot-provider-key-0123',
        'ghp_launchsitetoken0123',
        'github-token-value-0123',
      ])
    );
  });
});
