/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { getAdapterDefault } from './adapter-default-preferences.js';
import { EmailProvider, EmailParams, EmailResult } from './email-types.js';

export type EmailBackendOperation = 'create_draft' | 'send';

export interface EmailBackendAdapter extends EmailProvider {
  readonly priority?: number;
  readonly display_name?: string;
  readonly platforms?: string[];
  supportsOperation?(operation: EmailBackendOperation): boolean;
  unavailableMessage?(operation?: EmailBackendOperation): string;
}

export interface EmailBackendCandidate {
  id: string;
  display_name: string;
  adapter_id: string;
  status: 'ready' | 'needs_setup' | 'unsupported';
  selectable: boolean;
  reason: string;
}

function buildJxaScript(op: 'create_draft' | 'send', params: EmailParams): string {
  const to = (params.to ?? '').replace(/"/g, '\\"');
  const cc = (params.cc ?? '').replace(/"/g, '\\"');
  const subject = (params.subject ?? '(no subject)').replace(/"/g, '\\"');
  const body = (params.body ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  const fromAddr = (params.from ?? process.env.KYBERION_EMAIL_FROM ?? '').replace(/"/g, '\\"');

  const sendLine = op === 'send' ? 'msg.send()' : '// draft only';

  return `
ObjC.import('stdlib');
const Mail = Application('Mail');
Mail.activate();
const msg = Mail.OutgoingMessage({
  toRecipients: [Mail.Recipient({ address: "${to}" })],
  ${cc ? `ccRecipients: [Mail.Recipient({ address: "${cc}" })],` : ''}
  subject: "${subject}",
  content: "${body}",
  ${fromAddr ? `sender: "${fromAddr}",` : ''}
  visible: false
});
Mail.outgoingMessages.push(msg);
${sendLine}
"ok"
`.trim();
}

export class MacMailAppEmailProvider implements EmailProvider {
  readonly id = 'mac_mailapp';
  readonly display_name = 'macOS Mail.app';
  readonly priority = 20;
  readonly platforms = ['darwin'];

  isAvailable(): boolean {
    return process.platform === 'darwin';
  }

  supportsOperation(): boolean {
    return true;
  }

  unavailableMessage(): string {
    return 'Email backend "mac_mailapp" requires macOS Mail.app.';
  }

  async send(params: EmailParams): Promise<EmailResult> {
    return this.runJxa('send', params);
  }

  async createDraft(params: EmailParams): Promise<EmailResult> {
    return this.runJxa('create_draft', params);
  }

  private async runJxa(op: 'create_draft' | 'send', params: EmailParams): Promise<EmailResult> {
    const script = buildJxaScript(op, params);
    return new Promise((resolve) => {
      const child = spawn('osascript', ['-l', 'JavaScript', '-e', script], {
        cwd: pathResolver.rootDir(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('close', (code) => {
        if (code === 0 && stdout.trim() === 'ok') {
          resolve({
            status: 'succeeded',
            provider: this.id,
            message: 'JXA mail operation completed successfully.',
          });
        } else {
          resolve({
            status: 'failed',
            provider: this.id,
            error: stderr.trim() || `JXA script failed with exit code ${code}`,
          });
        }
      });
    });
  }
}

export class SmtpEmailProvider implements EmailProvider {
  readonly id = 'smtp';
  readonly display_name = 'SMTP';
  readonly priority = 10;
  readonly platforms = ['any'];

  isAvailable(): boolean {
    return Boolean(
      process.env.KYBERION_SMTP_HOST &&
      process.env.KYBERION_SMTP_USER &&
      process.env.KYBERION_SMTP_PASS
    );
  }

  supportsOperation(operation: EmailBackendOperation): boolean {
    return operation === 'send';
  }

  unavailableMessage(operation: EmailBackendOperation = 'send'): string {
    if (operation === 'create_draft') {
      return 'Email backend "smtp" does not support draft creation.';
    }
    return 'Email backend "smtp" requires KYBERION_SMTP_HOST, KYBERION_SMTP_USER, and KYBERION_SMTP_PASS.';
  }

  async send(params: EmailParams): Promise<EmailResult> {
    const host = process.env.KYBERION_SMTP_HOST;
    const user = process.env.KYBERION_SMTP_USER;
    const pass = process.env.KYBERION_SMTP_PASS;
    const port = parseInt(process.env.KYBERION_SMTP_PORT ?? '587', 10);
    const from = params.from ?? process.env.KYBERION_EMAIL_FROM ?? user ?? '';
    const to = params.to ?? '';
    const subject = params.subject ?? '(no subject)';
    const body = params.body ?? '';

    const pythonScript = `
import smtplib, ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

msg = MIMEMultipart()
msg['From'] = ${JSON.stringify(from)}
msg['To'] = ${JSON.stringify(to)}
msg['Subject'] = ${JSON.stringify(subject)}
msg.attach(MIMEText(${JSON.stringify(body)}, 'plain', 'utf-8'))

ctx = ssl.create_default_context()
with smtplib.SMTP(${JSON.stringify(host)}, ${port}) as server:
    server.ehlo()
    server.starttls(context=ctx)
    server.login(${JSON.stringify(user)}, ${JSON.stringify(pass)})
    server.sendmail(${JSON.stringify(from)}, ${JSON.stringify(to)}, msg.as_string())
print("ok")
`.trim();

    return new Promise((resolve) => {
      const child = spawn('python3', ['-c', pythonScript], {
        cwd: pathResolver.rootDir(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('close', (code) => {
        if (code === 0 && stdout.trim() === 'ok') {
          resolve({
            status: 'succeeded',
            provider: this.id,
            message: 'SMTP email sent successfully.',
          });
        } else {
          resolve({
            status: 'failed',
            provider: this.id,
            error: stderr.trim() || `SMTP python execution failed with exit code ${code}`,
          });
        }
      });
    });
  }

  async createDraft(params: EmailParams): Promise<EmailResult> {
    throw new Error(this.unavailableMessage('create_draft'));
  }
}

function supportsOperation(provider: EmailProvider, operation: EmailBackendOperation): boolean {
  const adapter = provider as EmailBackendAdapter;
  return (
    adapter.supportsOperation?.(operation) ??
    (operation === 'send' || provider.id === 'mac_mailapp')
  );
}

function unavailableMessage(provider: EmailProvider, operation: EmailBackendOperation): string {
  const adapter = provider as EmailBackendAdapter;
  return (
    adapter.unavailableMessage?.(operation) ||
    `Email backend "${provider.id}" is not available for ${operation}.`
  );
}

function backendPriority(adapter: EmailBackendAdapter): number {
  if (adapter.priority !== undefined) return adapter.priority;
  if (adapter.id === 'smtp') return 10;
  if (adapter.id === 'mac_mailapp') return 20;
  return 100;
}

export interface EmailBackendAvailabilityOverrides {
  [backendId: string]: boolean | undefined;
}

export class EmailBackendRegistry {
  private readonly adapters = new Map<string, EmailBackendAdapter>();

  constructor(adapters: readonly EmailBackendAdapter[] = []) {
    adapters.forEach((adapter) => this.register(adapter));
  }

  register(adapter: EmailBackendAdapter): this {
    const id = adapter.id.trim();
    if (!id) throw new Error('email-bridge: backend adapter id is required');
    if (this.adapters.has(id)) {
      throw new Error(`email-bridge: backend adapter "${id}" is already registered`);
    }
    this.adapters.set(id, adapter);
    return this;
  }

  get(id: string): EmailBackendAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(
        `email-bridge: unsupported backend "${id}". Available backends: ${this.ids().join(', ') || '(none)'}`
      );
    }
    return adapter;
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  async resolve(
    requested: string = 'auto',
    operation: EmailBackendOperation = 'send',
    availabilityOverrides: EmailBackendAvailabilityOverrides = {}
  ): Promise<EmailBackendAdapter> {
    const configured =
      requested === 'auto' ? getAdapterDefault('email.backend') || 'auto' : requested;
    if (configured !== 'auto') {
      const adapter = this.get(configured);
      if (!supportsOperation(adapter, operation)) {
        throw new Error(unavailableMessage(adapter, operation));
      }
      if (!(await this.isAvailable(adapter, availabilityOverrides))) {
        throw new Error(unavailableMessage(adapter, operation));
      }
      return adapter;
    }

    const available: EmailBackendAdapter[] = [];
    for (const adapter of this.adapters.values()) {
      if (
        supportsOperation(adapter, operation) &&
        (await this.isAvailable(adapter, availabilityOverrides))
      ) {
        available.push(adapter);
      }
    }
    available.sort((left, right) => backendPriority(left) - backendPriority(right));
    if (available[0]) return available[0];
    throw new Error(
      `email-bridge: no email backend is ready for ${operation}. ${[...this.adapters.values()]
        .filter((adapter) => supportsOperation(adapter, operation))
        .map((adapter) => unavailableMessage(adapter, operation))
        .join(' ')}`
    );
  }

  private async isAvailable(
    adapter: EmailBackendAdapter,
    availabilityOverrides: EmailBackendAvailabilityOverrides
  ): Promise<boolean> {
    const override = availabilityOverrides[adapter.id];
    return override === undefined ? await adapter.isAvailable() : override;
  }
}

export function createDefaultEmailBackendRegistry(): EmailBackendRegistry {
  return new EmailBackendRegistry([new MacMailAppEmailProvider(), new SmtpEmailProvider()]);
}

export const emailBackendRegistry = createDefaultEmailBackendRegistry();

export function registerEmailBackend(adapter: EmailBackendAdapter): EmailBackendRegistry {
  emailBackendRegistry.register(adapter);
  return emailBackendRegistry;
}

export function resolveEmailBackend(
  requested: string = 'auto',
  operation: EmailBackendOperation = 'send',
  registry: EmailBackendRegistry = emailBackendRegistry
): Promise<EmailBackendAdapter> {
  return registry.resolve(requested, operation);
}

export function listEmailBackends(
  registry: EmailBackendRegistry = emailBackendRegistry
): EmailBackendCandidate[] {
  return registry.ids().map((id) => {
    const adapter = registry.get(id);
    const supported =
      !adapter.platforms ||
      adapter.platforms.includes('any') ||
      adapter.platforms.includes(process.platform);
    const availability = adapter.isAvailable();
    const selectable = supported && (typeof availability === 'boolean' ? availability : false);
    return {
      id,
      display_name: adapter.display_name || id,
      adapter_id: `email.${id}`,
      status: !supported ? 'unsupported' : selectable ? 'ready' : 'needs_setup',
      selectable,
      reason: !supported
        ? `Email backend ${id} is not supported on platform ${process.platform}.`
        : selectable
          ? `Email backend ${id} is registered and available for sending.`
          : unavailableMessage(adapter, 'send'),
    };
  });
}

export class EmailPolicyRouter {
  private readonly registry: EmailBackendRegistry;

  constructor(providers: EmailBackendAdapter[]) {
    this.registry = new EmailBackendRegistry(providers);
  }

  async selectProvider(
    op: EmailBackendOperation,
    requestedBackend: string = 'auto'
  ): Promise<EmailBackendAdapter> {
    return this.registry.resolve(requestedBackend, op);
  }
}

let globalRouter: EmailPolicyRouter | null = null;

function getRouter(): EmailPolicyRouter {
  if (!globalRouter) {
    globalRouter = new EmailPolicyRouter([new MacMailAppEmailProvider(), new SmtpEmailProvider()]);
  }
  return globalRouter;
}

export async function sendEmail(params: EmailParams): Promise<EmailResult> {
  const router = getRouter();
  const { backend, ...providerParams } = params;
  const provider = await router.selectProvider('send', backend || 'auto');
  logger.info(`[email_bridge] Routing send request to provider: ${provider.id}`);
  return await provider.send(providerParams);
}

export async function createDraft(params: EmailParams): Promise<EmailResult> {
  const router = getRouter();
  const { backend, ...providerParams } = params;
  const provider = await router.selectProvider('create_draft', backend || 'auto');
  logger.info(`[email_bridge] Routing draft request to provider: ${provider.id}`);
  return await provider.createDraft(providerParams);
}
