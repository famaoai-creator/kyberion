/**
 * External secret-manager adapters on the `secret-provider` seam.
 *
 * Production runtimes (Cloud Run, ECS, Kubernetes) should not keep API keys
 * on disk. These adapters resolve `(service, account)` from a central secret
 * manager straight into memory. Each one is OPT-IN: it reports
 * `isAvailable() === false` until its Kyberion-namespaced configuration env
 * is set, so an unconfigured host keeps the pre-existing keychain → file →
 * env resolution untouched. Once configured they sit ahead of the local
 * stores in the governed chain (`seam-provider-selection/secret-provider.json`)
 * because an operator who points Kyberion at a central manager means it.
 *
 * Mapping (uniform across managers): one secret per `service`, holding a JSON
 * object keyed by `account`. A secret whose payload is not a JSON object is
 * treated as a single opaque value and returned for any account.
 *
 *   hashicorp_vault      KV v2 over HTTP (read/write) via governed secureFetch
 *   aws_secrets_manager  `aws secretsmanager get-secret-value` (read-only)
 *   gcp_secret_manager   `gcloud secrets versions access latest` (read-only)
 *   onepassword          `op read op://<vault>/<service>/<account>` (read-only)
 *
 * The CLI-backed adapters are read-only on purpose: their write paths take the
 * secret value in argv (visible in the process table), and in production the
 * secret's lifecycle belongs to IaC / the manager's own console, not the agent.
 * The CLIs carry their own auth (instance roles, workload identity, `op`
 * sessions), so no credential for the manager itself is stored by Kyberion.
 */

import { getRegisteredEnvText } from '../foundation/env.js';
import { safeExecResultAsync } from '../secure-io.js';
import type { SecretProvider } from './secret-types.js';

export const HASHICORP_VAULT_PROVIDER_ID = 'hashicorp_vault';
export const AWS_SECRETS_MANAGER_PROVIDER_ID = 'aws_secrets_manager';
export const GCP_SECRET_MANAGER_PROVIDER_ID = 'gcp_secret_manager';
export const ONEPASSWORD_PROVIDER_ID = 'onepassword';

export const EXTERNAL_SECRET_COMMAND_TIMEOUT_MS = 15_000;

/** Pick `account` out of a per-service payload (JSON object or opaque value). */
export function selectAccountValue(payload: string, account: string): string | null {
  const trimmed = payload.replace(/\r?\n$/u, '');
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>)[account];
        return typeof value === 'string' && value.length > 0 ? value : null;
      }
    } catch {
      // Not JSON after all — fall through to the opaque-value contract.
    }
  }
  return trimmed;
}

class ReadOnlySecretProviderError extends Error {
  constructor(id: string, verb: string) {
    super(
      `[SECRET_PROVIDER_READ_ONLY] ${id} does not support '${verb}' — manage this secret in the ` +
        `secret manager itself (console / IaC); Kyberion only reads it.`
    );
    this.name = 'ReadOnlySecretProviderError';
  }
}

// ---------------------------------------------------------------------------
// CLI-backed read-only adapters
// ---------------------------------------------------------------------------

export type ExternalSecretCommandRunner = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string; status: number | null; error?: Error }>;

const defaultCommandRunner: ExternalSecretCommandRunner = (command, args) =>
  safeExecResultAsync(command, args, {
    timeoutMs: EXTERNAL_SECRET_COMMAND_TIMEOUT_MS,
    maxOutputMB: 1,
  });

export interface CliSecretProviderSpec {
  id: string;
  command: string;
  /** Configuration env that opts the adapter in; unset → unavailable. */
  configEnv: string;
  /** argv that prints the per-service payload on stdout. */
  readArgs(config: string, service: string, account: string): string[];
  /** Whether stdout is the per-service payload (true) or already the account value. */
  payloadIsPerService?: boolean;
  /** Exit statuses / stderr patterns that mean "no such secret" rather than failure. */
  notFound?: RegExp;
}

export class CliSecretProvider implements SecretProvider {
  readonly id: string;
  private availability: Promise<boolean> | undefined;

  constructor(
    private readonly spec: CliSecretProviderSpec,
    private readonly run: ExternalSecretCommandRunner = defaultCommandRunner,
    private readonly env: () => string | undefined = () =>
      getRegisteredEnvText(spec.configEnv)?.trim() || undefined
  ) {
    this.id = spec.id;
  }

  async isAvailable(): Promise<boolean> {
    // Cheap env gate first: an unconfigured host never spawns the CLI.
    if (!this.env()) return false;
    this.availability ??= this.run(this.spec.command, ['--version']).then(
      (result) => result.status === 0 && !result.error,
      () => false
    );
    return this.availability;
  }

  async get(service: string, account: string): Promise<string | null> {
    const config = this.env();
    if (!config) return null;
    const result = await this.run(this.spec.command, this.spec.readArgs(config, service, account));
    if (result.status !== 0 || result.error) {
      if (this.spec.notFound?.test(result.stderr)) return null;
      throw new Error(
        `[SECRET_PROVIDER] ${this.id} read failed for ${service}/${account} — ` +
          `${this.spec.command} exited ${result.status ?? 'without status'} | next: check the ` +
          `CLI's auth and ${this.spec.configEnv} | evidence: ${firstLine(result.stderr) || result.error?.message || '-'}`
      );
    }
    return this.spec.payloadIsPerService === false
      ? result.stdout.replace(/\r?\n$/u, '') || null
      : selectAccountValue(result.stdout, account);
  }

  async set(): Promise<void> {
    throw new ReadOnlySecretProviderError(this.id, 'set');
  }

  async delete(): Promise<void> {
    throw new ReadOnlySecretProviderError(this.id, 'delete');
  }
}

/** `KYBERION_AWS_SECRETS_PREFIX`: secret id = `<prefix><service>`. */
export function createAwsSecretsManagerProvider(run?: ExternalSecretCommandRunner) {
  return new CliSecretProvider(
    {
      id: AWS_SECRETS_MANAGER_PROVIDER_ID,
      command: 'aws',
      configEnv: 'KYBERION_AWS_SECRETS_PREFIX',
      readArgs: (prefix, service) => [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        `${prefix}${service}`,
        '--query',
        'SecretString',
        '--output',
        'text',
      ],
      notFound: /ResourceNotFoundException/u,
    },
    run
  );
}

/** `KYBERION_GCP_SECRETS_PROJECT`: secret name = `kyberion-<service>` (sanitized). */
export function createGcpSecretManagerProvider(run?: ExternalSecretCommandRunner) {
  return new CliSecretProvider(
    {
      id: GCP_SECRET_MANAGER_PROVIDER_ID,
      command: 'gcloud',
      configEnv: 'KYBERION_GCP_SECRETS_PROJECT',
      readArgs: (project, service) => [
        'secrets',
        'versions',
        'access',
        'latest',
        `--secret=${gcpSecretName(service)}`,
        `--project=${project}`,
      ],
      notFound: /NOT_FOUND/u,
    },
    run
  );
}

/** `KYBERION_1PASSWORD_VAULT`: reference = `op://<vault>/<service>/<account>`. */
export function createOnePasswordProvider(run?: ExternalSecretCommandRunner) {
  return new CliSecretProvider(
    {
      id: ONEPASSWORD_PROVIDER_ID,
      command: 'op',
      configEnv: 'KYBERION_1PASSWORD_VAULT',
      readArgs: (vault, service, account) => [
        'read',
        `op://${vault}/${service}/${account}`,
        '--no-newline',
      ],
      payloadIsPerService: false,
      notFound: /isn't an item|could not find|not found/iu,
    },
    run
  );
}

export function gcpSecretName(service: string): string {
  return `kyberion-${service}`.replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 255);
}

// ---------------------------------------------------------------------------
// HashiCorp Vault (KV v2, read/write)
// ---------------------------------------------------------------------------

export interface VaultHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  data?: unknown;
}

/** Resolves the parsed JSON body; rejects with `{ httpStatus }` on non-2xx. */
export type VaultHttpTransport = (request: VaultHttpRequest) => Promise<unknown>;

const defaultVaultTransport: VaultHttpTransport = async (request) => {
  // Lazy: network.ts imports secret-guard, which reaches back into the secret
  // bridge — a static import here would close that cycle at module load.
  const { secureFetch } = await import('../network.js');
  return secureFetch({
    method: request.method,
    url: request.url,
    headers: request.headers,
    data: request.data,
    // The token header and the written value must reach Vault unredacted.
    authenticateRequest: true,
    // The address is operator configuration (often a loopback agent/sidecar),
    // never caller input.
    kyberion_allow_local_network: true,
  });
};

export interface VaultConfig {
  addr: string;
  token: string;
  mount: string;
  prefix: string;
  namespace?: string;
}

function vaultConfigFromEnv(): VaultConfig | undefined {
  const addr = getRegisteredEnvText('KYBERION_VAULT_ADDR')?.trim();
  const token = getRegisteredEnvText('KYBERION_VAULT_TOKEN')?.trim();
  if (!addr || !token) return undefined;
  return {
    addr: addr.replace(/\/+$/u, ''),
    token,
    mount: getRegisteredEnvText('KYBERION_VAULT_KV_MOUNT')?.trim() || 'secret',
    prefix: (getRegisteredEnvText('KYBERION_VAULT_PATH_PREFIX')?.trim() || 'kyberion').replace(
      /^\/+|\/+$/gu,
      ''
    ),
    namespace: getRegisteredEnvText('KYBERION_VAULT_NAMESPACE')?.trim() || undefined,
  };
}

function httpStatusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'httpStatus' in err) {
    const status = (err as { httpStatus?: unknown }).httpStatus;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

export class HashiCorpVaultSecretProvider implements SecretProvider {
  readonly id = HASHICORP_VAULT_PROVIDER_ID;

  constructor(
    private readonly transport: VaultHttpTransport = defaultVaultTransport,
    private readonly config: () => VaultConfig | undefined = vaultConfigFromEnv
  ) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.config());
  }

  private requireConfig(): VaultConfig {
    const config = this.config();
    if (!config) {
      throw new Error(
        '[SECRET_PROVIDER] hashicorp_vault is not configured — set KYBERION_VAULT_ADDR and KYBERION_VAULT_TOKEN'
      );
    }
    return config;
  }

  private dataUrl(config: VaultConfig, service: string): string {
    const segments = [config.mount, 'data', ...(config.prefix ? [config.prefix] : []), service];
    return `${config.addr}/v1/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
  }

  private headers(config: VaultConfig): Record<string, string> {
    return {
      'X-Vault-Token': config.token,
      'content-type': 'application/json',
      ...(config.namespace ? { 'X-Vault-Namespace': config.namespace } : {}),
    };
  }

  /** Current KV v2 payload + version for one service (empty when absent). */
  private async readService(
    config: VaultConfig,
    service: string
  ): Promise<{ data: Record<string, string>; version: number }> {
    let body: unknown;
    try {
      body = await this.transport({
        method: 'GET',
        url: this.dataUrl(config, service),
        headers: this.headers(config),
      });
    } catch (err) {
      if (httpStatusOf(err) === 404) return { data: {}, version: 0 };
      throw err;
    }
    const envelope = (body as { data?: { data?: unknown; metadata?: { version?: unknown } } })
      ?.data;
    const raw = envelope?.data;
    const data: Record<string, string> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string') data[key] = value;
      }
    }
    const version = typeof envelope?.metadata?.version === 'number' ? envelope.metadata.version : 0;
    return { data, version };
  }

  private async writeService(
    config: VaultConfig,
    service: string,
    data: Record<string, string>,
    version: number
  ): Promise<void> {
    // check-and-set on the version we read: a concurrent writer makes this
    // fail instead of silently dropping its account.
    await this.transport({
      method: 'POST',
      url: this.dataUrl(config, service),
      headers: this.headers(config),
      data: { options: { cas: version }, data },
    });
  }

  async get(service: string, account: string): Promise<string | null> {
    const config = this.requireConfig();
    const { data } = await this.readService(config, service);
    const value = data[account];
    return value ? value : null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const config = this.requireConfig();
    const current = await this.readService(config, service);
    await this.writeService(
      config,
      service,
      { ...current.data, [account]: value },
      current.version
    );
  }

  async delete(service: string, account: string): Promise<void> {
    const config = this.requireConfig();
    const current = await this.readService(config, service);
    if (!(account in current.data)) return;
    const { [account]: _removed, ...rest } = current.data;
    await this.writeService(config, service, rest, current.version);
  }
}

export function createExternalSecretProviders(): SecretProvider[] {
  return [
    new HashiCorpVaultSecretProvider(),
    createAwsSecretsManagerProvider(),
    createGcpSecretManagerProvider(),
    createOnePasswordProvider(),
  ];
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/u)
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 200) ?? ''
  );
}
