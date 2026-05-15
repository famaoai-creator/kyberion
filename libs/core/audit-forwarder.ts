/**
 * Audit Forwarder — pluggable publish bridge for the hash-chained audit log.
 * Forwards each AuditEntry to an external SIEM / log-sink after it has been
 * appended to the local chain.
 *
 * Design:
 *   - The local append-only file stays authoritative (tamper-evident).
 *   - The forwarder fires asynchronously; failures are logged but never
 *     block record() — a SIEM outage should not halt Kyberion's own ops.
 *   - Multiple forwarders can chain via `ChainAuditForwarder`.
 *
 * Built-ins:
 *   - stubAuditForwarder      — no-op, used when no sink is configured.
 *   - ShellAuditForwarder     — pipes the entry JSON to a user-configured
 *                               shell command (e.g. `logger -t kyberion` or
 *                               a custom syslog feeder).
 *   - HttpAuditForwarder      — POSTs the entry to an HTTP(S) endpoint
 *                               (e.g. Splunk HEC, Datadog Logs API).
 */

import { execFileSync } from 'node:child_process';
import { logger } from './core.js';
import { redactSensitiveObject } from './network.js';
import type { AuditEntry } from './audit-chain.js';

export interface AuditForwarder {
  name: string;
  publish(entry: AuditEntry): Promise<void> | void;
}

let registered: AuditForwarder | null = null;

export function registerAuditForwarder(forwarder: AuditForwarder): void {
  registered = forwarder;
}

export function getAuditForwarder(): AuditForwarder {
  return registered ?? stubAuditForwarder;
}

export function resetAuditForwarder(): void {
  registered = null;
}

export const stubAuditForwarder: AuditForwarder = {
  name: 'stub',
  publish(_entry) {
    // no-op
  },
};

export class ChainAuditForwarder implements AuditForwarder {
  readonly name: string;
  constructor(private readonly forwarders: AuditForwarder[], name = 'chain') {
    this.name = `${name}(${forwarders.map((f) => f.name).join('→')})`;
  }
  async publish(entry: AuditEntry): Promise<void> {
    for (const f of this.forwarders) {
      try {
        await f.publish(entry);
      } catch (err: any) {
        logger.warn(
          `[audit-forwarder:chain] ${f.name} failed for ${entry.id}: ${err?.message ?? err}`,
        );
      }
    }
  }
}

/**
 * Tenant-filtering forwarder. Wraps an inner forwarder and only delegates
 * publish() when the entry's `tenantSlug` matches one of `tenantSlugs` (or
 * when `passThroughTenantless` is true and the entry has no tenant).
 *
 * Used to give each tenant its own SIEM / log sink without leaking
 * cross-tenant events. Compose multiple of these inside a ChainAuditForwarder
 * — one per tenant.
 */
export class TenantFilteringAuditForwarder implements AuditForwarder {
  readonly name: string;
  constructor(
    private readonly inner: AuditForwarder,
    private readonly tenantSlugs: string[],
    private readonly passThroughTenantless: boolean = false,
  ) {
    this.name = `tenant-filter(${tenantSlugs.join(',')}→${inner.name})`;
  }
  async publish(entry: AuditEntry): Promise<void> {
    const slug = entry.tenantSlug;
    if (!slug) {
      if (!this.passThroughTenantless) return;
    } else if (!this.tenantSlugs.includes(slug)) {
      return;
    }
    await this.inner.publish(entry);
  }
}

export interface ShellAuditForwarderOptions {
  /**
   * Shell command. `{{entry}}` (escaped JSON string) is replaced at publish
   * time. Stdin also receives the raw JSON if the command supports it.
   *
   * Examples:
   *   `logger -t kyberion -p local0.info`                        (syslog)
   *   `/usr/local/bin/kyberion-audit-ship.sh`                    (custom)
   *   `aws logs put-log-events --log-group-name kyberion ...`    (CloudWatch)
   */
  command: string;
  shell?: string;
  timeoutMs?: number;
}

export class ShellAuditForwarder implements AuditForwarder {
  readonly name = 'shell';
  constructor(private readonly options: ShellAuditForwarderOptions) {}

  publish(entry: AuditEntry): void {
    const json = JSON.stringify(redactSensitiveObject(entry));
    const cmd = this.options.command.replace(/\{\{entry\}\}/gu, shellEscape(json));
    const shell = this.options.shell ?? process.env.SHELL ?? '/bin/sh';
    try {
      execFileSync(shell, ['-c', cmd], {
        input: `${json}\n`,
        encoding: 'utf8',
        timeout: this.options.timeoutMs ?? 10_000,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (err: any) {
      logger.warn(`[audit-forwarder:shell] publish failed for ${entry.id}: ${err?.message ?? err}`);
    }
  }
}

function shellEscape(value: string): string {
  // Single-quote wrap, escape embedded single quotes.
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export interface HttpAuditForwarderOptions {
  /** Full endpoint URL. */
  url: string;
  /** HTTP method. Defaults to 'POST'. */
  method?: string;
  /** Static headers. Secrets should be provided through env references. */
  headers?: Record<string, string>;
  /** Timeout ms. Defaults to 5 seconds — audit ship should be fast. */
  timeoutMs?: number;
}

export class HttpAuditForwarder implements AuditForwarder {
  readonly name = 'http';
  constructor(private readonly options: HttpAuditForwarderOptions) {}

  async publish(entry: AuditEntry): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
    try {
      const redactedEntry = redactSensitiveObject(entry);
      const response = await fetch(this.options.url, {
        method: this.options.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(redactedEntry),
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn(
          `[audit-forwarder:http] non-OK ${response.status} for ${entry.id}: ${await response.text().catch(() => '')}`,
        );
      }
    } catch (err: any) {
      logger.warn(`[audit-forwarder:http] publish failed for ${entry.id}: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Bootstrap — installs a Shell / HTTP forwarder (or both chained) when
 * the relevant env vars are present.
 *
 *   KYBERION_AUDIT_FORWARDER_COMMAND  — shell sink
 *   KYBERION_AUDIT_FORWARDER_URL      — http sink (with optional
 *                                        KYBERION_AUDIT_FORWARDER_HEADERS
 *                                        as a JSON string of headers)
 */
export function installAuditForwarderIfAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const command = env.KYBERION_AUDIT_FORWARDER_COMMAND?.trim();
  const url = env.KYBERION_AUDIT_FORWARDER_URL?.trim();
  const forwarders: AuditForwarder[] = [];
  if (command) {
    forwarders.push(
      new ShellAuditForwarder({
        command,
        ...(env.KYBERION_AUDIT_FORWARDER_TIMEOUT_MS
          ? { timeoutMs: parseInt(env.KYBERION_AUDIT_FORWARDER_TIMEOUT_MS, 10) }
          : {}),
      }),
    );
  }
  if (url) {
    let headers: Record<string, string> = {};
    try {
      if (env.KYBERION_AUDIT_FORWARDER_HEADERS) {
        headers = JSON.parse(env.KYBERION_AUDIT_FORWARDER_HEADERS);
      }
    } catch (err: any) {
      logger.warn(`[audit-forwarder] failed to parse KYBERION_AUDIT_FORWARDER_HEADERS: ${err?.message ?? err}`);
    }
    forwarders.push(
      new HttpAuditForwarder({
        url,
        headers,
        ...(env.KYBERION_AUDIT_FORWARDER_TIMEOUT_MS
          ? { timeoutMs: parseInt(env.KYBERION_AUDIT_FORWARDER_TIMEOUT_MS, 10) }
          : {}),
      }),
    );
  }
  if (forwarders.length === 0) return false;
  registerAuditForwarder(
    forwarders.length === 1 ? forwarders[0] : new ChainAuditForwarder(forwarders),
  );
  logger.success(
    `[audit-forwarder] installed ${forwarders.map((f) => f.name).join(' + ')} forwarder`,
  );
  return true;
}
