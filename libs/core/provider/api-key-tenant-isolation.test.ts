import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';
import {
  hasTaskCredentialBinding,
  withTaskCredentialBinding,
} from '../foundation/credential-binding.js';
import { buildProviderChildEnv } from './provider-permission-profiles.js';
import { providerTenantIsolationForBackend } from './provider-tenant-isolation.js';

const tenant = 'apikey-iso-tenant';
const KEY = 'sk-bound-secret-0123456789';

const runScoped = <T>(tenant_: string, run: () => T): T =>
  withExecutionContext('sovereign_concierge', run, 'sovereign', tenant_);

/** Mirror of the lending broker: spec env → binding → child env. */
function boundChildEnv(provider: string, opts: { kind?: 'api_key' | 'subscription_token' } = {}) {
  const spec = providerTenantIsolationForBackend(
    {
      codex: 'codex-cli',
      gemini: 'gemini-cli',
      agy: 'agy-cli',
      cursor: 'cursor-cli',
    }[provider]!
  )!;
  const envKey = {
    codex: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    agy: 'GEMINI_API_KEY',
    cursor: 'CURSOR_API_KEY',
  }[provider]!;
  const built = spec.buildEnvironment('confidential', tenant, `tenant:owner:${provider}:key`);
  const binding = {
    tenantSlug: tenant,
    secrets: opts.kind === 'api_key' ? { [envKey]: KEY } : {},
    ...(opts.kind ? { credentialKind: opts.kind } : {}),
    providerEnvironments: { [provider]: built },
  };
  const child = runScoped(tenant, () =>
    withTaskCredentialBinding(binding, () => buildProviderChildEnv({ provider }))
  );
  return { spec, built, child, home: built.HOME! };
}

afterEach(() =>
  runScoped(tenant, () =>
    safeRmSync(pathResolver.rootResolve('active/shared/cache/confidential/' + tenant), {
      recursive: true,
      force: true,
    })
  )
);

describe('generic API-key tenant isolation (spec → binding → child env)', () => {
  for (const [provider, envKey] of [
    ['gemini', 'GEMINI_API_KEY'],
    ['agy', 'GEMINI_API_KEY'],
    ['cursor', 'CURSOR_API_KEY'],
  ] as const) {
    it(`${provider}: isolates HOME on the tenant floor and injects only the bound key`, () => {
      const { built, child, home } = boundChildEnv(provider, { kind: 'api_key' });
      // Isolated HOME under the tenant's private floor, created on disk.
      expect(home).toContain(path.join('confidential', tenant, 'provider-auth', provider));
      expect(safeExistsSync(home)).toBe(true);
      expect(child.HOME).toBe(home);
      expect(built.HOME).toBe(home);
      // Exactly the bound credential reaches the child.
      expect(child[envKey]).toBe(KEY);
    });
  }

  for (const provider of ['codex', 'gemini', 'agy', 'cursor'] as const) {
    it(`${provider}: refuses a bound launch without an api_key credential kind`, () => {
      expect(() => boundChildEnv(provider)).toThrow(/CREDENTIAL_PROVIDER_DENIED/);
      expect(() => boundChildEnv(provider, { kind: 'subscription_token' })).toThrow(
        /CREDENTIAL_PROVIDER_DENIED/
      );
    });
  }

  it('codex: pins CODEX_HOME inside the bound HOME and delivers auth.json', () => {
    const { built, child, home } = boundChildEnv('codex', { kind: 'api_key' });
    expect(built.CODEX_HOME).toBe(path.join(home, '.codex'));
    expect(child.CODEX_HOME).toBe(path.join(home, '.codex'));
    expect(safeExistsSync(built.CODEX_HOME!)).toBe(true);
    // codex authenticates from $CODEX_HOME/auth.json, not env — the key must
    // be on disk, never in the child's environment.
    expect(child.OPENAI_API_KEY).toBeUndefined();
    expect(safeExistsSync(path.join(child.CODEX_HOME!, 'auth.json'))).toBe(true);
    // The credential store is pinned to auth.json so a bound codex cannot
    // fall back to the operator's OS keyring (the default "auto" store).
    expect(safeExistsSync(path.join(child.CODEX_HOME!, 'config.toml'))).toBe(true);
  });

  it('agy: writes modelProvider "gemini" settings into the isolated HOME', () => {
    const { home } = boundChildEnv('agy', { kind: 'api_key' });
    const settings = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    // The home lands on the tenant's confidential floor — a concierge context
    // cannot read tenant confidential material back, which is the point.
    expect(safeExistsSync(settings)).toBe(true);
    expect(() => safeReadFile(settings, { encoding: 'utf8' })).toThrow(/access denied/i);
  });

  it('drops every other credential-family var from the operator env', () => {
    const spec = providerTenantIsolationForBackend('agy-cli')!;
    const built = spec.buildEnvironment('confidential', tenant, 'tenant:owner:gemini:key');
    runScoped(tenant, () =>
      withTaskCredentialBinding(
        {
          tenantSlug: tenant,
          secrets: { GEMINI_API_KEY: KEY },
          credentialKind: 'api_key',
          providerEnvironments: { agy: built },
        },
        () => {
          const env = buildProviderChildEnv({
            provider: 'agy',
            baseEnv: {
              PATH: '/bin',
              GEMINI_API_KEY: 'operator-key-must-be-replaced',
              GOOGLE_API_KEY: 'ambient',
              KYBERION_GEMINI_API_KEY: 'ambient',
              XAI_API_KEY: 'other-provider',
              GH_TOKEN: 'leak',
            } as NodeJS.ProcessEnv,
          });
          expect(env.GEMINI_API_KEY).toBe(KEY); // bound value wins
          expect(env.GOOGLE_API_KEY).toBeUndefined();
          expect(env.KYBERION_GEMINI_API_KEY).toBeUndefined();
          expect(env.XAI_API_KEY).toBeUndefined();
          expect(env.GH_TOKEN).toBeUndefined();
        }
      )
    );
  });

  it('refuses a CODEX_HOME smuggled outside the bound HOME', () => {
    const spec = providerTenantIsolationForBackend('codex-cli')!;
    const built = spec.buildEnvironment('confidential', tenant, 'tenant:owner:codex:key');
    built.CODEX_HOME = '/etc/passwd-dir';
    expect(() =>
      runScoped(tenant, () =>
        withTaskCredentialBinding(
          {
            tenantSlug: tenant,
            secrets: { OPENAI_API_KEY: KEY },
            credentialKind: 'api_key',
            providerEnvironments: { codex: built },
          },
          () => buildProviderChildEnv({ provider: 'codex' })
        )
      )
    ).toThrow(/CREDENTIAL_(HOME_REQUIRED|PROVIDER_DENIED)/);
  });

  it('boundSecretValues returns the bound key only while bound', () => {
    const spec = providerTenantIsolationForBackend('agy-cli')!;
    const built = spec.buildEnvironment('confidential', tenant, 'tenant:owner:gemini:key');
    expect(spec.boundSecretValues()).toEqual([]);
    runScoped(tenant, () =>
      withTaskCredentialBinding(
        {
          tenantSlug: tenant,
          secrets: { GEMINI_API_KEY: KEY },
          credentialKind: 'api_key',
          providerEnvironments: { agy: built },
        },
        () => expect(spec.boundSecretValues()).toEqual([KEY])
      )
    );
    expect(hasTaskCredentialBinding()).toBe(false);
    expect(spec.boundSecretValues()).toEqual([]);
  });
});
