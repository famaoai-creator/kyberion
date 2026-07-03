/* eslint-disable no-restricted-imports -- IP-08 で managed-process 経由へ移行予定 (docs/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { EmailProvider, EmailParams, EmailResult } from './email-types.js';

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

  async isAvailable(): Promise<boolean> {
    return process.platform === 'darwin';
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

  async isAvailable(): Promise<boolean> {
    return Boolean(
      process.env.KYBERION_SMTP_HOST &&
      process.env.KYBERION_SMTP_USER &&
      process.env.KYBERION_SMTP_PASS
    );
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
    throw new Error('Draft creation is not supported in SMTP mode.');
  }
}

export class EmailPolicyRouter {
  private providers: Map<string, EmailProvider> = new Map();

  constructor(providers: EmailProvider[]) {
    for (const p of providers) {
      this.providers.set(p.id, p);
    }
  }

  async selectProvider(op: 'create_draft' | 'send'): Promise<EmailProvider> {
    if (op === 'create_draft') {
      const provider = this.providers.get('mac_mailapp');
      if (provider && (await provider.isAvailable())) {
        return provider;
      }
      throw new Error('create_draft is only supported on macOS Mail.app.');
    }

    // For sending emails: SMTP is preferred if configured, otherwise falls back to macOS Mail.app
    const chain = ['smtp', 'mac_mailapp'];
    for (const id of chain) {
      const provider = this.providers.get(id);
      if (provider && (await provider.isAvailable())) {
        return provider;
      }
    }
    throw new Error('No available Email Provider resolved.');
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
  const provider = await router.selectProvider('send');
  logger.info(`[email_bridge] Routing send request to provider: ${provider.id}`);
  return await provider.send(params);
}

export async function createDraft(params: EmailParams): Promise<EmailResult> {
  const router = getRouter();
  const provider = await router.selectProvider('create_draft');
  logger.info(`[email_bridge] Routing draft request to provider: ${provider.id}`);
  return await provider.createDraft(params);
}
