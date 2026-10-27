import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContextAsync } from '../authority.js';
import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import { buildApiProviderBundle } from '../reasoning/reasoning-api-provider.js';
import { AnthropicReasoningBackend } from './anthropic-reasoning-backend.js';
import { AnthropicIntentExtractor } from './anthropic-intent-extractor.js';
import { AnthropicVoiceBridge } from './anthropic-voice-bridge.js';
import { createAnthropicCredentialClient } from './anthropic-credential-client.js';
import { metrics } from '../metrics.js';

// Credential ownership is the subject here; provider egress has its own scoped suites.
vi.mock('../reasoning/reasoning-egress-scope.js', async (original) => ({
  ...(await original<typeof import('../reasoning/reasoning-egress-scope.js')>()),
  assertReasoningEgressAllowed: vi.fn(),
}));
beforeEach(() => {
  vi.stubEnv('KYBERION_TENANT', '');
  // Auth fixtures are not metering probes; their fake SDK turns must not add
  // tenant rows to the shared ledger used by other suites in the same run.
  vi.spyOn(metrics, 'record').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function tenant<T>(name: string, key: string, run: () => T) {
  return withExecutionContextAsync(
    'infrastructure_sentinel',
    async () =>
      withTaskCredentialBinding({ tenantSlug: name, secrets: { ANTHROPIC_API_KEY: key } }, run),
    undefined,
    name
  );
}
const clientOf = (instance: unknown) => (instance as { client: Anthropic }).client;
const roleplay = {
  objective: 'practice',
  timeBudgetMinutes: 5,
  personaSpec: {},
  outputPath: 'active/shared/tmp/fixture.json',
};
const oneOnOne = {
  counterpartyRef: 'people/fixture.json',
  proposalDraftRef: 'draft.json',
  structure: ['review'],
  outputPath: 'active/shared/tmp/fixture.json',
};
const parsed = {
  goal: 'fixture',
  constraints: [],
  deliverables: [],
  excluded: [],
  stakeholders: [],
  turns: [
    { speaker: 'sovereign', text: 'one' },
    { speaker: 'counterparty', text: 'two' },
  ],
  transcript: [],
  stance: 'neutral',
  conditions: [],
  dissent_signals: [],
};

describe('Anthropic credential client isolation', () => {
  it('rejects opaque tenant SDK clients in every adapter and the actual factory', async () => {
    const client = { messages: { create: vi.fn(), parse: vi.fn() } } as unknown as Anthropic;
    await tenant('acme', 'tenant-fixture', () => {
      for (const construct of [
        () => new AnthropicReasoningBackend({ client }),
        () => new AnthropicIntentExtractor({ client }),
        () => new AnthropicVoiceBridge({ client }),
        () => buildApiProviderBundle({ mode: 'anthropic', anthropicClient: client }),
      ])
        expect(construct).toThrow('CREDENTIAL_OWNER_DENIED');
    });
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(client.messages.parse).not.toHaveBeenCalled();
  });

  it('actual tenant factory builds all three SDK clients from bound keys without ambient auth/baseURL/headers', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'operator-fixture');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'operator-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://operator.example.invalid');
    vi.stubEnv(
      'ANTHROPIC_CUSTOM_HEADERS',
      'X-Api-Key: operator-header\nAuthorization: Bearer operator-header\nCookie: operator-cookie'
    );
    await tenant('acme', 'tenant-fixture', async () => {
      const bundle = buildApiProviderBundle({
        mode: 'anthropic',
        env: { ANTHROPIC_API_KEY: 'operator-env-fixture' },
      })!;
      const backend = bundle.backend!.backend;
      const intent = bundle.intentExtractor!.extractor;
      const voice = bundle.voiceBridge!.bridge;
      for (const instance of [backend, intent, voice]) {
        const client = clientOf(instance);
        expect(client.apiKey).toBe('tenant-fixture');
        expect(client.authToken).toBeNull();
        expect(client.baseURL).toBe('https://api.anthropic.com');
        expect(client.maxRetries).toBe(0);
        expect(
          (client as unknown as { _options: { defaultHeaders: object } })._options.defaultHeaders
        ).toEqual({});
        vi.spyOn(client.messages, 'parse').mockResolvedValue({ parsed_output: parsed } as never);
      }
      vi.spyOn(clientOf(backend).messages, 'create').mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
      } as never);
      await backend.generateWithTools!('fixture', []);
      expect(await intent.extract({ text: 'fixture' })).toMatchObject({ goal: 'fixture' });
      await voice.runRoleplaySession(roleplay);
      await voice.runOneOnOneSession(oneOnOne);
      expect(clientOf(intent).messages.parse).toHaveBeenCalledWith(expect.any(Object), {
        maxRetries: 0,
      });
      expect(clientOf(voice).messages.parse).toHaveBeenCalledWith(expect.any(Object), {
        maxRetries: 0,
      });
    });
  });

  it('fails closed for absent tenant bindings/keys even when an operator env key exists', async () => {
    await expect(
      withExecutionContextAsync(
        'infrastructure_sentinel',
        async () =>
          buildApiProviderBundle({
            mode: 'anthropic',
            env: { ANTHROPIC_API_KEY: 'operator-fixture' },
          }),
        undefined,
        'acme'
      )
    ).rejects.toThrow('CREDENTIAL_BINDING_REQUIRED');
    await expect(
      tenant('acme', '', () =>
        buildApiProviderBundle({
          mode: 'anthropic',
          env: { ANTHROPIC_API_KEY: 'operator-fixture' },
        })
      )
    ).rejects.toThrow('CREDENTIAL_KEY_UNAVAILABLE');
  });

  it('denies cached clients in another tenant or after a same-tenant key change', async () => {
    const binding = await tenant('acme', 'first-key', () => createAnthropicCredentialClient());
    await expect(tenant('other', 'first-key', () => binding.assertBinding())).rejects.toThrow(
      'CREDENTIAL_OWNER_DENIED'
    );
    await expect(tenant('acme', 'rotated-key', () => binding.assertBinding())).rejects.toThrow(
      'binding changed'
    );
  });

  it('rejects a modified SDK auth configuration even when execution ownership still matches', async () => {
    await tenant('acme', 'tenant-fixture', () => {
      const credentials = createAnthropicCredentialClient();
      credentials.client.apiKey = 'operator-fixture';
      expect(() => credentials.assertBinding()).toThrow('configuration changed');
    });
  });

  it.each(['roleplay', 'one-on-one'])(
    'revalidates %s credentials after input serialization callbacks',
    async (kind) => {
      await tenant('acme', 'tenant-fixture', async () => {
        const voice = new AnthropicVoiceBridge();
        const client = clientOf(voice);
        const parse = vi
          .spyOn(client.messages, 'parse')
          .mockResolvedValue({ parsed_output: parsed } as never);
        const mutate = () => {
          client.apiKey = 'operator-fixture';
          return {};
        };
        const result =
          kind === 'roleplay'
            ? voice.runRoleplaySession({ ...roleplay, personaSpec: { toJSON: mutate } })
            : voice.runOneOnOneSession({
                ...oneOnOne,
                structure: Object.assign([], { toJSON: mutate }),
              });
        await expect(result).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
        expect(parse).not.toHaveBeenCalled();
      });
    }
  );

  it('denies cached operator adapters before any SDK call under a tenant', async () => {
    const parse = vi.fn();
    const create = vi.fn();
    const client = { messages: { create, parse } } as unknown as Anthropic;
    const backend = new AnthropicReasoningBackend({ client });
    const intent = new AnthropicIntentExtractor({ client });
    const voice = new AnthropicVoiceBridge({ client });
    await tenant('acme', 'tenant-fixture', async () => {
      await expect(backend.generateWithTools('fixture', [])).rejects.toThrow(
        'CREDENTIAL_OWNER_DENIED'
      );
      await expect(intent.extract({ text: 'fixture' })).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
      await expect(voice.runRoleplaySession(roleplay)).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
      await expect(voice.runOneOnOneSession(oneOnOne)).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
    });
    expect(create).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it('preserves operator injected clients and disables request-level retries', async () => {
    const parse = vi.fn().mockResolvedValue({ parsed_output: parsed });
    const client = { messages: { create: vi.fn(), parse } } as unknown as Anthropic;
    const bundle = buildApiProviderBundle({ mode: 'anthropic', anthropicClient: client })!;
    expect(clientOf(bundle.backend!.backend)).toBe(client);
    await bundle.intentExtractor!.extractor.extract({ text: 'fixture' });
    await bundle.voiceBridge!.bridge.runRoleplaySession(roleplay);
    expect(parse).toHaveBeenCalledWith(expect.any(Object), { maxRetries: 0 });
  });
});
