import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from './execution-scope.js';
import {
  credentialExecutionIdentity,
  withTaskCredentialBinding,
  resolveTaskCredential,
} from './credential-binding.js';
import {
  getSecret,
  getSecretForIdentity,
  getActiveSecrets,
  maskActiveSecrets,
  redactActiveSecretsForHostLog,
  loadConnectionDocument,
} from '../secret/secret-guard.js';
import { resolveSecretAsync } from '../secret/secret-resolver.js';
import { buildProviderChildEnv } from '../provider/provider-permission-profiles.js';
import { OpenAiCompatibleBackend } from '../provider/openai-compatible-backend.js';
import { GeminiApiBackend } from '../provider/gemini-api-backend.js';
import { resolveServiceBinding } from '../service/service-binding.js';
import { withExecutionContext } from '../authority.js';
import { runInResourceAccessScope } from './resource-access-scope.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { currentScopeEnvelope, mintScopeEnvelope, withScopeEnvelope } from '../scope-envelope.js';

const providerHome = pathResolver.rootResolve(
  'active/shared/tmp/confidential/alpha/provider-auth/vitest-root-binding'
);
const credentialScopePath = pathResolver.sharedTmp(`credential-binding-scope-${process.pid}.env`);

const tenant = <T>(tenantSlug: string, run: () => T): T =>
  runInExecutionScope({ tenantBound: true, tenantSlug }, run);

afterEach(() => {
  withExecutionContext('mission_controller', () =>
    safeRmSync(credentialScopePath, { force: true })
  );
  withExecutionContext(
    'sovereign_concierge',
    () => safeRmSync(providerHome, { recursive: true, force: true }),
    'sovereign',
    'alpha'
  );
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('task-local credential binding', () => {
  it('honors a trusted explicit public tenant clear without reopening a parent credential binding', () => {
    vi.stubEnv('KYBERION_TENANT', 'alpha');
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_TASK_ID', '');
    withExecutionContext(
      'infrastructure_sentinel',
      () => {
        expect(credentialExecutionIdentity().tenantSlug).toBeUndefined();
      },
      undefined,
      ''
    );
    tenant('alpha', () =>
      withTaskCredentialBinding(
        {
          tenantSlug: 'alpha',
          secrets: { TEST_BOUND_KEY: 'tenant-secret' },
        },
        () =>
          withExecutionContext(
            'infrastructure_sentinel',
            () => {
              expect(() => resolveTaskCredential('TEST_BOUND_KEY')).toThrow(
                '[CREDENTIAL_SCOPE_DENIED]'
              );
            },
            undefined,
            ''
          )
      )
    );
    runInExecutionScope({ tenantBound: true }, () => {
      expect(() => credentialExecutionIdentity()).toThrow('Missing runtime tenant');
    });
    withExecutionContext(
      'infrastructure_sentinel',
      () =>
        runInResourceAccessScope(
          {
            tenantSlug: 'alpha',
            readExact: [],
            writeExact: [],
            mkdirExact: [],
          },
          () => {
            expect(() => credentialExecutionIdentity()).toThrow('[CREDENTIAL_SCOPE_DENIED]');
          }
        ),
      undefined,
      ''
    );
  });
  it('uses the canonical persisted identity and still refuses ambient credentials', () => {
    safeWriteFile(
      credentialScopePath,
      'KYBERION_TENANT=alpha\nMISSION_ID=MSN-PERSISTED\nKYBERION_TASK_ID=TASK-PERSISTED\n',
      { mkdir: true }
    );
    vi.stubEnv('KYBERION_SCOPE_ENV_PATH', credentialScopePath);
    vi.stubEnv('KYBERION_TENANT', '');
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_TASK_ID', '');
    vi.stubEnv('TEST_BOUND_KEY', 'operator');
    expect(credentialExecutionIdentity()).toEqual({
      tenantSlug: 'alpha',
      missionId: 'MSN-PERSISTED',
      taskId: 'TASK-PERSISTED',
    });
    expect(() => getSecret('TEST_BOUND_KEY')).toThrow('[CREDENTIAL_BINDING_REQUIRED]');
    withTaskCredentialBinding({ tenantSlug: 'alpha', secrets: {} }, () => {
      expect(getSecret('TEST_BOUND_KEY')).toBeNull();
    });
    runInResourceAccessScope(
      { tenantSlug: 'beta', readExact: [], writeExact: [], mkdirExact: [] },
      () => expect(() => credentialExecutionIdentity()).toThrow('[CREDENTIAL_SCOPE_DENIED]')
    );
    vi.stubEnv('MISSION_ID', 'MSN-ENV');
    vi.stubEnv('KYBERION_TASK_ID', 'TASK-ENV');
    expect(credentialExecutionIdentity()).toMatchObject({
      missionId: 'MSN-ENV',
      taskId: 'TASK-ENV',
    });
  });

  it('preserves explicit execution identity and null clears over configured fallbacks', () => {
    vi.stubEnv('KYBERION_TENANT', 'beta');
    vi.stubEnv('MISSION_ID', 'MSN-ENV');
    vi.stubEnv('KYBERION_TASK_ID', 'TASK-ENV');
    withExecutionContext(
      'infrastructure_sentinel',
      () => {
        expect(credentialExecutionIdentity()).toEqual({
          tenantSlug: 'alpha',
          missionId: undefined,
          taskId: 'TASK-BOUND',
        });
        withTaskCredentialBinding({ tenantSlug: 'alpha', secrets: {} }, () => {
          expect(resolveTaskCredential('TEST_BOUND_KEY')).toBeNull();
        });
      },
      undefined,
      'alpha',
      undefined,
      { missionId: null, taskId: 'TASK-BOUND' }
    );
  });

  it.each(['missionId', 'taskId'] as const)(
    'refuses to resurrect explicitly cleared %s from an active envelope',
    (clearedField) => {
      vi.stubEnv('KYBERION_TENANT', '');
      vi.stubEnv('MISSION_ID', '');
      vi.stubEnv('KYBERION_TASK_ID', '');
      const lineage = { missionId: 'MSN-CREDENTIAL-ENVELOPE', taskId: 'TASK-ENVELOPE' };
      const envelope = mintScopeEnvelope({
        env: {
          KYBERION_TIER: 'confidential',
          KYBERION_TENANT: 'alpha',
          MISSION_ID: lineage.missionId,
          KYBERION_TASK_ID: lineage.taskId,
          KYBERION_SCOPE_ENV_PATH: credentialScopePath,
        },
        policy: { purpose: 'credential lineage regression' },
      });
      const before = currentScopeEnvelope();
      withScopeEnvelope(envelope, () => {
        expect(currentScopeEnvelope()).toBe(envelope);
        withExecutionContext(
          'infrastructure_sentinel',
          () => {
            expect(() => credentialExecutionIdentity()).toThrow('[CREDENTIAL_SCOPE_DENIED]');
          },
          undefined,
          ''
        );
        // Omitted lineage may still use the active envelope consistently.
        expect(credentialExecutionIdentity()).toEqual({ tenantSlug: 'alpha', ...lineage });
        withTaskCredentialBinding(
          { tenantSlug: 'alpha', secrets: { TEST_BOUND_KEY: 'scoped-only' } },
          () => {
            expect(resolveTaskCredential('TEST_BOUND_KEY')).toBe('scoped-only');
            withExecutionContext(
              'infrastructure_sentinel',
              () => {
                expect(() => credentialExecutionIdentity()).toThrow('[CREDENTIAL_SCOPE_DENIED]');
                expect(() => resolveTaskCredential('TEST_BOUND_KEY')).toThrow(
                  '[CREDENTIAL_SCOPE_DENIED]'
                );
                expect(() =>
                  withTaskCredentialBinding({ tenantSlug: 'alpha', secrets: {} }, () => {})
                ).toThrow('[CREDENTIAL_SCOPE_DENIED]');
              },
              undefined,
              'alpha',
              undefined,
              { ...lineage, [clearedField]: null }
            );
            // The rejected child neither invalidates nor widens its parent binding.
            expect(resolveTaskCredential('TEST_BOUND_KEY')).toBe('scoped-only');
          }
        );
      });
      expect(currentScopeEnvelope()).toBe(before);
    }
  );

  it('rejects invalid configured tenants instead of treating them as an unbound operator', () => {
    safeWriteFile(credentialScopePath, 'KYBERION_TENANT=../foreign\n', { mkdir: true });
    vi.stubEnv('KYBERION_TENANT', '../foreign');
    expect(() => credentialExecutionIdentity()).toThrow('[CREDENTIAL_SCOPE_DENIED]');
    tenant('alpha', () => {
      expect(credentialExecutionIdentity().tenantSlug).toBe('alpha');
    });
    vi.stubEnv('KYBERION_TENANT', '');
    vi.stubEnv('KYBERION_SCOPE_ENV_PATH', credentialScopePath);
    expect(() => credentialExecutionIdentity()).toThrow('[CREDENTIAL_SCOPE_DENIED]');
  });

  it('does not reveal process-global secret diagnostics to a different task', () => {
    vi.stubEnv('TEST_BOUND_KEY', 'operator-diagnostic-secret');
    getSecret('TEST_BOUND_KEY');
    tenant('alpha', () =>
      withTaskCredentialBinding(
        { tenantSlug: 'alpha', secrets: { TEST_BOUND_KEY: 'alpha-diagnostic-secret' } },
        () => {
          getSecret('TEST_BOUND_KEY');
          expect(getActiveSecrets()).toContain('alpha-diagnostic-secret');
          expect(getActiveSecrets()).not.toContain('operator-diagnostic-secret');
          expect(maskActiveSecrets('operator-diagnostic-secret alpha-diagnostic-secret')).toBe(
            'operator-diagnostic-secret [REDACTED_SECRET]'
          );
          expect(
            redactActiveSecretsForHostLog('operator-diagnostic-secret alpha-diagnostic-secret')
          ).toBe('[REDACTED_SECRET] [REDACTED_SECRET]');
        }
      )
    );
  });
  it('does not let a resource ceiling replace runtime identity or rescue a missing tenant', () => {
    const resource = { tenantSlug: 'beta', readExact: [], writeExact: [], mkdirExact: [] };
    tenant('alpha', () =>
      runInResourceAccessScope(resource, () => {
        expect(() =>
          withTaskCredentialBinding({ tenantSlug: 'beta', secrets: {} }, () => {})
        ).toThrow('[CREDENTIAL_SCOPE_DENIED]');
      })
    );
    runInResourceAccessScope(resource, () => {
      expect(() =>
        withTaskCredentialBinding({ tenantSlug: 'beta', secrets: {} }, () => {})
      ).toThrow('[CREDENTIAL_SCOPE_DENIED]');
    });
  });

  it('does not fall through a scoped identity miss to operator keychain or personal connections', () => {
    tenant('alpha', () =>
      withTaskCredentialBinding({ tenantSlug: 'alpha', secrets: {} }, () => {
        expect(
          getSecretForIdentity({
            envName: 'TEST_BOUND_KEY',
            keychainService: 'test',
            keychainAccount: 'bound_key',
          })
        ).toBeNull();
        expect(() => loadConnectionDocument('slack')).toThrow('[CREDENTIAL_CONNECTION_DENIED]');
      })
    );
  });
  it('pins an omitted task id to the current runtime task and rejects same-tenant drift', () => {
    withExecutionContext(
      'infrastructure_sentinel',
      () =>
        withTaskCredentialBinding(
          { tenantSlug: 'alpha', secrets: { TEST_BOUND_KEY: 'only-a' } },
          () => {
            expect(resolveTaskCredential('TEST_BOUND_KEY')).toBe('only-a');
            withExecutionContext(
              'infrastructure_sentinel',
              () => {
                expect(() => resolveTaskCredential('TEST_BOUND_KEY')).toThrow(
                  '[CREDENTIAL_SCOPE_DENIED]'
                );
                expect(() => buildProviderChildEnv({ provider: 'claude' })).toThrow(
                  '[CREDENTIAL_SCOPE_DENIED]'
                );
              },
              undefined,
              'alpha',
              undefined,
              { taskId: 'task-b' }
            );
          }
        ),
      undefined,
      'alpha',
      undefined,
      { taskId: 'task-a' }
    );
  });

  it('refuses an operator-created cached service token in tenant execution', () => {
    vi.stubEnv('AUTHORIZED_SCOPE', 'slack');
    vi.stubEnv('SLACK_BOT_TOKEN', 'operator-slack-token');
    const binding = resolveServiceBinding('slack', 'secret-guard', ['accessToken']);
    expect(binding.accessToken).toBe('operator-slack-token');
    tenant('alpha', () =>
      withTaskCredentialBinding(
        { tenantSlug: 'alpha', secrets: { SLACK_BOT_TOKEN: 'alpha' } },
        () => {
          expect(() => binding.accessToken).toThrow('[CREDENTIAL_OWNER_DENIED]');
        }
      )
    );
  });
  it('retains operator env flow and refuses tenant ambient fallback', () => {
    vi.stubEnv('TEST_BOUND_KEY', 'operator-secret');
    expect(getSecret('TEST_BOUND_KEY')).toBe('operator-secret');
    tenant('alpha', () => {
      expect(() => getSecret('TEST_BOUND_KEY')).toThrow('[CREDENTIAL_BINDING_REQUIRED]');
      withTaskCredentialBinding({ tenantSlug: 'alpha', secrets: {} }, () => {
        expect(getSecret('TEST_BOUND_KEY')).toBeNull();
      });
    });
  });

  it('isolates interleaved asynchronous lookups, and does not grant service access', async () => {
    const values = await Promise.all(
      ['alpha', 'beta'].map((tenantSlug) =>
        tenant(tenantSlug, () =>
          withTaskCredentialBinding(
            { tenantSlug, secrets: { TEST_BOUND_KEY: tenantSlug, SLACK_TOKEN: 'x' } },
            async () => {
              await Promise.resolve();
              expect(() => getSecret('SLACK_TOKEN', 'slack')).toThrow('TIBA_VIOLATION');
              return [
                getSecret('TEST_BOUND_KEY'),
                await resolveSecretAsync({ key: 'TEST_BOUND_KEY' }),
              ];
            }
          )
        )
      )
    );
    expect(values).toEqual([
      ['alpha', 'alpha'],
      ['beta', 'beta'],
    ]);
  });

  it('rejects scope drift, nested widening and mutable caller maps', () => {
    tenant('alpha', () => {
      const secrets = { TEST_BOUND_KEY: 'original' };
      withTaskCredentialBinding({ tenantSlug: 'alpha', secrets }, () => {
        secrets.TEST_BOUND_KEY = 'changed';
        expect(resolveTaskCredential('TEST_BOUND_KEY')).toBe('original');
        expect(() => tenant('beta', () => getSecret('TEST_BOUND_KEY'))).toThrow(
          '[CREDENTIAL_SCOPE_DENIED]'
        );
        expect(() => withTaskCredentialBinding({ tenantSlug: 'alpha', secrets }, () => {})).toThrow(
          '[CREDENTIAL_SCOPE_DENIED]'
        );
      });
    });
  });

  it('never inherits operator CLI auth or permits the allowlist escape hatch in a tenant', () => {
    vi.stubEnv('KYBERION_TIER', 'confidential');
    withExecutionContext(
      'sovereign_concierge',
      () => {
        safeMkdir(providerHome, { recursive: true });
        expect(() => buildProviderChildEnv({ provider: 'claude' })).toThrow(
          '[CREDENTIAL_BINDING_REQUIRED]'
        );
        withTaskCredentialBinding({ tenantSlug: 'alpha', secrets: {} }, () => {
          expect(() => buildProviderChildEnv({ provider: 'claude' })).toThrow(
            '[CREDENTIAL_PROVIDER_DENIED]'
          );
        });
        withTaskCredentialBinding(
          {
            tenantSlug: 'alpha',
            secrets: {},
            providerEnvironments: {
              claude: {
                HOME: providerHome,
                PATH: '/bin',
                ANTHROPIC_API_KEY: 'alpha-key',
                OTHER_TOKEN: 'never',
                KYBERION_PROVIDER_ENV_ALLOWLIST: '0',
              },
              gemini: {
                HOME: providerHome,
                PATH: '/bin',
                KYBERION_GEMINI_API_KEY: 'alpha-gemini',
                KYBERION_SUDO: 'true',
              },
            },
          },
          () => {
            const env = buildProviderChildEnv({
              provider: 'claude',
              baseEnv: { HOME: '/operator', ANTHROPIC_API_KEY: 'operator' },
            });
            expect(env.HOME).toBe(providerHome);
            expect(env.ANTHROPIC_API_KEY).toBe('alpha-key');
            expect(env.OTHER_TOKEN).toBeUndefined();
            expect(env.KYBERION_TENANT).toBe('alpha');
            const gemini = buildProviderChildEnv({ provider: 'gemini' });
            expect(gemini.KYBERION_GEMINI_API_KEY).toBe('alpha-gemini');
            expect(gemini.KYBERION_SUDO).toBeUndefined();
          }
        );
      },
      'sovereign',
      'alpha'
    );
  });

  it('checks cached compatible-client ownership before sending and uses bound keys', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetch);
    const operator = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'fake',
      apiKey: 'operator',
    });
    await tenant('alpha', () =>
      withTaskCredentialBinding(
        { tenantSlug: 'alpha', secrets: { TEST_BOUND_KEY: 'alpha-key' } },
        async () => {
          await expect(operator.prompt('hello')).rejects.toThrow('[CREDENTIAL_OWNER_DENIED]');
          expect(fetch).not.toHaveBeenCalled();
          const backend = new OpenAiCompatibleBackend({
            baseURL: 'http://127.0.0.1:11434/v1',
            model: 'fake',
            apiKey: 'operator',
            credentialKeys: ['TEST_BOUND_KEY'],
          });
          await expect(backend.prompt('hello')).resolves.toBe('ok');
          expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
            authorization: 'Bearer alpha-key',
          });
        }
      )
    );
  });

  it('checks Gemini ownership before reaching its request transport', async () => {
    const request = vi.fn();
    const operator = new GeminiApiBackend({ apiKey: 'operator', model: 'fake', request });
    await tenant('alpha', () =>
      withTaskCredentialBinding(
        { tenantSlug: 'alpha', secrets: { GEMINI_API_KEY: 'alpha' } },
        async () => {
          await expect(operator.prompt('hello')).rejects.toThrow('[CREDENTIAL_OWNER_DENIED]');
          expect(request).not.toHaveBeenCalled();
        }
      )
    );
  });
});
