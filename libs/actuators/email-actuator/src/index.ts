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
import { logger } from '@agent/core/core';
import { retry } from '@agent/core/async-utils';
import { resolveVars } from '@agent/core/src/logic-utils';
import { sendEmail, createDraft } from '@agent/core/email-bridge';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeExistsSync,
  safeLstat,
} from '@agent/core/secure-io';
import { defineCatalogBackedActuator, runActuatorPipeline } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

interface EmailParams {
  backend?: string;
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
  const absPath = assertSafeRepositoryPath(
    path.isAbsolute(filePath) ? filePath : pathResolver.rootResolve(filePath),
    { allowMissingLeaf: true }
  );
  if (!safeExistsSync(absPath)) {
    throw new Error(`email-actuator: body_file not found: ${absPath}`);
  }
  if (!safeLstat(absPath).isFile()) {
    throw new Error(`email-actuator: body_file must be a regular file: ${absPath}`);
  }
  return String(safeReadFile(absPath, { encoding: 'utf8' })).trim();
}

function resolveEmailParams(raw: EmailParams, ctx: Record<string, unknown>): EmailParams {
  return {
    backend: raw.backend !== undefined ? String(resolveVars(raw.backend, ctx)) : undefined,
    to: raw.to !== undefined ? String(resolveVars(raw.to, ctx)) : undefined,
    cc: raw.cc !== undefined ? String(resolveVars(raw.cc, ctx)) : undefined,
    subject: raw.subject !== undefined ? String(resolveVars(raw.subject, ctx)) : undefined,
    body: raw.body !== undefined ? String(resolveVars(raw.body, ctx)) : undefined,
    body_file: raw.body_file !== undefined ? String(resolveVars(raw.body_file, ctx)) : undefined,
    from: raw.from !== undefined ? String(resolveVars(raw.from, ctx)) : undefined,
    export_as: raw.export_as,
  };
}

async function executeEmailOp(
  op: string,
  rawParams: EmailParams,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  // Resolve {{vars}} from pipeline context after preflight, preserving the
  // previous email actuator contract.
  let params: EmailParams = resolveEmailParams(rawParams, ctx);

  // Read body from file for send_from_file, and also for create_draft/send when body_file provided
  if (params.body_file && !params.body) {
    params.body = resolveBodyFromFile(params.body_file);
  }
  if (op === 'send_from_file' && !params.body) {
    throw new Error('email-actuator send_from_file: body_file is required and could not be read');
  }

  switch (op) {
    case 'create_draft': {
      logger.info(`[EMAIL] Creating draft → To: ${params.to}, Subject: ${params.subject}`);
      const result = await retry(() => createDraft(params), {
        maxRetries: 2,
        initialDelayMs: 1000,
        maxDelayMs: 8000,
        factor: 2,
        jitter: true,
      });
      logger.success(`[EMAIL] Draft created`);
      if (params.export_as) ctx = { ...ctx, [params.export_as]: result.message || 'success' };
      break;
    }
    case 'send':
    case 'send_from_file': {
      logger.info(`[EMAIL] Sending → To: ${params.to ?? ''}, Subject: ${params.subject ?? ''}`);
      const result = await retry(() => sendEmail(params), {
        maxRetries: 2,
        initialDelayMs: 1000,
        maxDelayMs: 8000,
        factor: 2,
        jitter: true,
      });
      logger.success(`[EMAIL] Sent → To: ${params.to}, Subject: ${params.subject}`);
      if (params.export_as) ctx = { ...ctx, [params.export_as]: result.message || 'success' };
      break;
    }
    default:
      throw new Error(`email-actuator: unknown op: ${op}`);
  }
  return ctx;
}

export async function handleAction(input: {
  action: string;
  steps?: Array<{ type?: string; op: string; params?: EmailParams }>;
  context?: Record<string, unknown>;
  params?: EmailParams & { context?: Record<string, unknown> };
}): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> =
    input.context ?? (input.params?.context as Record<string, unknown>) ?? {};

  if (input.action === 'pipeline' && Array.isArray(input.steps)) {
    return runActuatorPipeline({
      actuatorId: 'email',
      steps: input.steps,
      context: ctx,
      execute: executeEmailOp,
    });
  }

  // Direct op call
  const op = input.action as EmailAction['op'];
  const params: EmailParams = input.params ?? {};
  const newCtx = await runActuatorPipeline({
    actuatorId: 'email',
    steps: [{ op, params }],
    context: ctx,
    execute: executeEmailOp,
  });
  return { ...newCtx, status: 'succeeded' };
}

export const EMAIL_ACTUATOR_OPS = ['create_draft', 'send', 'send_from_file'] as const;

export const actuator = defineCatalogBackedActuator({
  id: 'email-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
