import { describe, expect, it } from 'vitest';
import {
  HashiCorpVaultSecretProvider,
  createAwsSecretsManagerProvider,
  createGcpSecretManagerProvider,
  createOnePasswordProvider,
  gcpSecretName,
  selectAccountValue,
  type ExternalSecretCommandRunner,
  type VaultHttpRequest,
} from './external-secret-providers.js';
import { listSecretProviders } from './provider-registry.js';
import './secret-bridge.js';

describe('selectAccountValue', () => {
  it('picks the account from a per-service JSON object', () => {
    expect(selectAccountValue('{"api_key":"k1","other":"k2"}\n', 'api_key')).toBe('k1');
    expect(selectAccountValue('{"other":"k2"}', 'api_key')).toBeNull();
  });
  it('treats a non-object payload as one opaque value', () => {
    expect(selectAccountValue('plain-token\n', 'anything')).toBe('plain-token');
    expect(selectAccountValue('', 'anything')).toBeNull();
  });
});

function recordingRunner(
  respond: (command: string, args: string[]) => { stdout?: string; stderr?: string; status: number }
): ExternalSecretCommandRunner & { calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  const runner = (async (command: string, args: string[]) => {
    calls.push([command, args]);
    const r = respond(command, args);
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  }) as ExternalSecretCommandRunner & { calls: Array<[string, string[]]> };
  runner.calls = calls;
  return runner;
}

describe('CLI-backed secret managers', () => {
  it('stay unavailable — and never spawn — until their config env is set', async () => {
    const envs = [
      'KYBERION_AWS_SECRETS_PREFIX',
      'KYBERION_GCP_SECRETS_PROJECT',
      'KYBERION_1PASSWORD_VAULT',
    ] as const;
    const saved = envs.map((name) => [name, process.env[name]] as const);
    for (const name of envs) delete process.env[name];
    try {
      const runner = recordingRunner(() => ({ status: 0 }));
      for (const provider of [
        createAwsSecretsManagerProvider(runner),
        createGcpSecretManagerProvider(runner),
        createOnePasswordProvider(runner),
      ]) {
        expect(await provider.isAvailable()).toBe(false);
        expect(await provider.get('svc', 'acct')).toBeNull();
      }
      expect(runner.calls).toEqual([]);
    } finally {
      for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    }
  });

  it('reads AWS Secrets Manager per-service JSON and maps NotFound to null', async () => {
    process.env.KYBERION_AWS_SECRETS_PREFIX = 'prod/kyberion/';
    try {
      const runner = recordingRunner((_c, args) =>
        args.includes('prod/kyberion/openai')
          ? { status: 0, stdout: '{"api_key":"sk-test"}\n' }
          : args[0] === '--version'
            ? { status: 0 }
            : { status: 254, stderr: 'An error occurred (ResourceNotFoundException)' }
      );
      const aws = createAwsSecretsManagerProvider(runner);
      expect(await aws.isAvailable()).toBe(true);
      expect(await aws.get('openai', 'api_key')).toBe('sk-test');
      expect(await aws.get('missing', 'api_key')).toBeNull();
      await expect(aws.set()).rejects.toThrow(/SECRET_PROVIDER_READ_ONLY/);
    } finally {
      delete process.env.KYBERION_AWS_SECRETS_PREFIX;
    }
  });

  it('surfaces real CLI failures as diagnostic errors without the payload', async () => {
    process.env.KYBERION_GCP_SECRETS_PROJECT = 'proj-1';
    try {
      const runner = recordingRunner(() => ({ status: 1, stderr: 'PERMISSION_DENIED: nope' }));
      const gcp = createGcpSecretManagerProvider(runner);
      await expect(gcp.get('slack', 'bot')).rejects.toThrow(/gcp_secret_manager read failed/);
      expect(runner.calls[0]![1]).toContain('--secret=kyberion-slack');
      expect(runner.calls[0]![1]).toContain('--project=proj-1');
    } finally {
      delete process.env.KYBERION_GCP_SECRETS_PROJECT;
    }
  });

  it('reads 1Password through an op:// reference', async () => {
    process.env.KYBERION_1PASSWORD_VAULT = 'Agents';
    try {
      const runner = recordingRunner(() => ({ status: 0, stdout: 'xoxb-1' }));
      const op = createOnePasswordProvider(runner);
      expect(await op.get('slack', 'bot_token')).toBe('xoxb-1');
      expect(runner.calls[0]).toEqual([
        'op',
        ['read', 'op://Agents/slack/bot_token', '--no-newline'],
      ]);
    } finally {
      delete process.env.KYBERION_1PASSWORD_VAULT;
    }
  });

  it('sanitizes GCP secret names', () => {
    expect(gcpSecretName('my.service/x')).toBe('kyberion-my-service-x');
  });
});

describe('HashiCorpVaultSecretProvider', () => {
  const config = () => ({
    addr: 'http://127.0.0.1:8200',
    token: 'hvs.test',
    mount: 'secret',
    prefix: 'kyberion',
  });

  function fakeVault() {
    const store = new Map<string, { data: Record<string, string>; version: number }>();
    const requests: VaultHttpRequest[] = [];
    const transport = async (request: VaultHttpRequest) => {
      requests.push(request);
      const current = store.get(request.url);
      if (request.method === 'GET') {
        if (!current) throw Object.assign(new Error('404'), { httpStatus: 404 });
        return { data: { data: current.data, metadata: { version: current.version } } };
      }
      const body = request.data as { options: { cas: number }; data: Record<string, string> };
      if (body.options.cas !== (current?.version ?? 0)) {
        throw Object.assign(new Error('cas mismatch'), { httpStatus: 400 });
      }
      store.set(request.url, { data: body.data, version: (current?.version ?? 0) + 1 });
      return {};
    };
    return { store, requests, transport };
  }

  it('is unavailable without address + token', async () => {
    expect(await new HashiCorpVaultSecretProvider(undefined, () => undefined).isAvailable()).toBe(
      false
    );
  });

  it('round-trips accounts under one KV v2 secret per service with check-and-set', async () => {
    const vault = fakeVault();
    const provider = new HashiCorpVaultSecretProvider(vault.transport, config);
    expect(await provider.get('openai', 'api_key')).toBeNull();
    await provider.set('openai', 'api_key', 'sk-1');
    await provider.set('openai', 'org', 'org-1');
    expect(await provider.get('openai', 'api_key')).toBe('sk-1');
    await provider.delete('openai', 'api_key');
    expect(await provider.get('openai', 'api_key')).toBeNull();
    expect(await provider.get('openai', 'org')).toBe('org-1');

    const url = 'http://127.0.0.1:8200/v1/secret/data/kyberion/openai';
    expect(vault.store.get(url)?.version).toBe(3);
    expect(vault.requests.every((r) => r.headers['X-Vault-Token'] === 'hvs.test')).toBe(true);
  });

  it('propagates non-404 transport failures', async () => {
    const provider = new HashiCorpVaultSecretProvider(async () => {
      throw Object.assign(new Error('forbidden'), { httpStatus: 403 });
    }, config);
    await expect(provider.get('openai', 'api_key')).rejects.toThrow('forbidden');
  });
});

describe('secret-provider seam registration', () => {
  it('registers the external managers alongside the local builtins', () => {
    const ids = listSecretProviders().map((p) => p.id);
    for (const id of [
      'hashicorp_vault',
      'aws_secrets_manager',
      'gcp_secret_manager',
      'onepassword',
    ]) {
      expect(ids).toContain(id);
    }
  });
});
