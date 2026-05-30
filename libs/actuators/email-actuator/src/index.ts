/**
 * email-actuator/src/index.ts
 * Email composition and sending via macOS Mail.app (JXA) with SMTP fallback.
 *
 * Ops:
 *   create_draft     — Create draft in Mail.app (darwin only, no send)
 *   send             — Send via Mail.app (darwin) or SMTP (cross-platform)
 *   send_from_file   — Read body from file path, then send
 *
 * SMTP mode: set KYBERION_SMTP_HOST + KYBERION_SMTP_USER + KYBERION_SMTP_PASS
 * Mail.app mode: macOS only, no credentials required (uses logged-in account)
 */

import * as path from 'node:path';
import {
  logger,
  safeExec,
  safeReadFile,
  safeExistsSync,
  pathResolver,
  withRetry,
  resolveVars,
} from '@agent/core';

const PLATFORMS_DARWIN = process.platform === 'darwin';

interface EmailParams {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  body_file?: string;
  from?: string;
  export_as?: string;
}

interface EmailAction {
  op: 'create_draft' | 'send' | 'send_from_file';
  params?: EmailParams;
}

function resolveBodyFromFile(filePath: string): string {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : pathResolver.rootResolve(filePath);
  if (!safeExistsSync(absPath)) {
    throw new Error(`email-actuator: body_file not found: ${absPath}`);
  }
  return String(safeReadFile(absPath, { encoding: 'utf8' })).trim();
}

function buildJxaScript(op: 'create_draft' | 'send', params: EmailParams): string {
  const to = (params.to ?? '').replace(/"/g, '\\"');
  const cc = (params.cc ?? '').replace(/"/g, '\\"');
  const subject = (params.subject ?? '(no subject)').replace(/"/g, '\\"');
  const body = (params.body ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
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

async function sendViaMail(op: 'create_draft' | 'send', params: EmailParams): Promise<string> {
  if (!PLATFORMS_DARWIN) {
    throw new Error('email-actuator: Mail.app mode requires macOS. Set KYBERION_SMTP_* env vars for SMTP mode.');
  }
  const script = buildJxaScript(op, params);
  const result = safeExec('osascript', ['-l', 'JavaScript', '-e', script], {
    cwd: pathResolver.rootDir(),
  });
  return result.trim();
}

async function sendViaSmtp(params: EmailParams): Promise<string> {
  const host = process.env.KYBERION_SMTP_HOST;
  const user = process.env.KYBERION_SMTP_USER;
  const pass = process.env.KYBERION_SMTP_PASS;
  const port = parseInt(process.env.KYBERION_SMTP_PORT ?? '587', 10);
  const from = params.from ?? process.env.KYBERION_EMAIL_FROM ?? user ?? '';
  const to = params.to ?? '';
  const subject = params.subject ?? '(no subject)';
  const body = params.body ?? '';

  if (!host || !user || !pass) {
    throw new Error(
      'email-actuator: SMTP mode requires KYBERION_SMTP_HOST, KYBERION_SMTP_USER, KYBERION_SMTP_PASS',
    );
  }

  // Use Python's smtplib (available on all platforms without extra packages)
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

  const result = safeExec('python3', ['-c', pythonScript], { cwd: pathResolver.rootDir() });
  return result.trim();
}

function isSmtpConfigured(): boolean {
  return !!(process.env.KYBERION_SMTP_HOST && process.env.KYBERION_SMTP_USER && process.env.KYBERION_SMTP_PASS);
}

function resolveEmailParams(raw: EmailParams, ctx: Record<string, unknown>): EmailParams {
  return {
    to: raw.to !== undefined ? String(resolveVars(raw.to, ctx)) : undefined,
    cc: raw.cc !== undefined ? String(resolveVars(raw.cc, ctx)) : undefined,
    subject: raw.subject !== undefined ? String(resolveVars(raw.subject, ctx)) : undefined,
    body: raw.body !== undefined ? String(resolveVars(raw.body, ctx)) : undefined,
    body_file: raw.body_file !== undefined ? String(resolveVars(raw.body_file, ctx)) : undefined,
    from: raw.from !== undefined ? String(resolveVars(raw.from, ctx)) : undefined,
    export_as: raw.export_as,
  };
}

async function executePipeline(
  steps: Array<{ type?: string; op: string; params?: EmailParams }>,
  ctx: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (const step of steps) {
    const rawParams: EmailParams = step.params ?? {};
    // Resolve {{vars}} from pipeline context before using params
    const params: EmailParams = resolveEmailParams(rawParams, ctx);

    // Read body from file for send_from_file, and also for create_draft/send when body_file provided
    if (params.body_file && !params.body) {
      params.body = resolveBodyFromFile(params.body_file);
    }
    if (step.op === 'send_from_file' && !params.body) {
      throw new Error('email-actuator send_from_file: body_file is required and could not be read');
    }

    switch (step.op) {
      case 'create_draft': {
        logger.info(`[EMAIL] Creating draft → To: ${params.to}, Subject: ${params.subject}`);
        const result = await withRetry(() => sendViaMail('create_draft', params), {
          maxRetries: 2,
          initialDelayMs: 1000,
          maxDelayMs: 8000,
          factor: 2,
          jitter: true,
        });
        logger.success(`[EMAIL] Draft created in Mail.app`);
        if (params.export_as) ctx = { ...ctx, [params.export_as]: result };
        break;
      }
      case 'send':
      case 'send_from_file': {
        logger.info(`[EMAIL] Sending → To: ${params.to ?? ''}, Subject: ${params.subject ?? ''}`);
        const result = await withRetry(
          () => isSmtpConfigured() ? sendViaSmtp(params) : sendViaMail('send', params),
          { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 8000, factor: 2, jitter: true },
        );
        logger.success(`[EMAIL] Sent → To: ${params.to}, Subject: ${params.subject}`);
        if (params.export_as) ctx = { ...ctx, [params.export_as]: result };
        break;
      }
      default:
        throw new Error(`email-actuator: unknown op: ${step.op}`);
    }
  }
  return ctx;
}

export async function handleAction(input: {
  action: string;
  steps?: Array<{ type?: string; op: string; params?: EmailParams }>;
  context?: Record<string, unknown>;
  params?: EmailParams & { context?: Record<string, unknown> };
}): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = input.context ?? (input.params?.context as Record<string, unknown>) ?? {};

  if (input.action === 'pipeline' && Array.isArray(input.steps)) {
    return executePipeline(input.steps, ctx);
  }

  // Direct op call
  const op = input.action as EmailAction['op'];
  const params: EmailParams = input.params ?? {};
  const newCtx = await executePipeline([{ op, params }], ctx);
  return { ...newCtx, status: 'succeeded' };
}

export const EMAIL_ACTUATOR_OPS = ['create_draft', 'send', 'send_from_file'] as const;
