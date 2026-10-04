import { classifyError } from '@agent/core/error-classifier';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import * as pathResolver from '@agent/core/path-resolver';
import { persistTrace, TraceContext } from '@agent/core/trace';
import { ensureDefaultOpPreflight } from '@agent/core/pipeline/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/pipeline/op-preflight';
import { createAjv } from '@agent/core/foundation';
import { readJson } from '@agent/core/foundation/json';
import { logger } from '@agent/core/core';
import {
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeUnlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import type { ValidateFunction } from 'ajv';
import * as path from 'node:path';

export type SchedulerAction = {
  op: 'schedule' | 'list' | 'cancel' | 'fire';
  params?: {
    id?: string;
    cron?: string;
    payload?: Record<string, unknown>;
    enabled?: boolean;
  };
};

export type ScheduleDeclaration = {
  id: string;
  cron: string;
  payload: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * Durable schedule declarations live under active/shared/runtime/scheduler/
 * (state purpose per the runtime-storage-layout table). Tenant-bearing
 * payloads stay in this tenant-neutral store only as opaque declarations;
 * never place tenant data under a system/ floor.
 */
const SCHEDULER_STORE_RELATIVE = 'active/shared/runtime/scheduler';

const SCHEDULER_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/scheduler-action.schema.json'
);

let cachedValidator: ValidateFunction | null = null;
let storeDirOverride: string | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = createAjv();
  cachedValidator = compileSchemaFromPath(ajv, SCHEDULER_SCHEMA_PATH);
  return cachedValidator;
}

export function resolveStoreDir(): string {
  if (storeDirOverride) return storeDirOverride;
  return pathResolver.rootResolve(SCHEDULER_STORE_RELATIVE);
}

/** Test-only store isolation; production always uses the governed store dir. */
export function __setStoreDirForTests(dir: string | null): void {
  storeDirOverride = dir;
}

const ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CRON_FIELD_PATTERN = /^[A-Za-z0-9*,\-/?]+$/u;

function assertValidId(id: string): string {
  const trimmed = id.trim();
  if (!ID_SEGMENT_PATTERN.test(trimmed)) {
    throw new Error(
      `scheduler-actuator: invalid id '${id}': use 1-128 [A-Za-z0-9._-] characters starting with an alphanumeric`
    );
  }
  return trimmed;
}

/** Minimal cron validation: exactly 5 space-separated fields. */
export function validateCron(cron: string): string {
  const trimmed = cron.trim();
  const fields = trimmed.split(/\s+/u);
  if (fields.length !== 5 || fields.some((field) => !CRON_FIELD_PATTERN.test(field))) {
    throw new Error(
      `scheduler-actuator: invalid cron '${cron}': expected 5 space-separated fields (minute hour day month weekday), e.g. '0 9 * * 1'`
    );
  }
  return trimmed;
}

function missingRequiredFields(action: SchedulerAction): string[] {
  const params = action.params || {};
  if (action.op === 'schedule') {
    const missing: string[] = [];
    if (!params.cron?.trim()) missing.push('params.cron (e.g. "0 9 * * 1")');
    if (params.payload === undefined || params.payload === null) {
      missing.push('params.payload (object passed through on fire)');
    }
    return missing;
  }
  if (action.op === 'cancel' || action.op === 'fire') {
    if (!params.id?.trim()) return ['params.id'];
    return [];
  }
  return [];
}

function validateAction(input: unknown): SchedulerAction {
  const validate = getValidator();
  if (!validate(input)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
      .join('; ');
    throw new Error(`scheduler-actuator: invalid input: ${errors}`);
  }
  const action = input as SchedulerAction;
  const missing = missingRequiredFields(action);
  if (missing.length) {
    throw new Error(`scheduler-actuator: missing required fields: ${missing.join(', ')}`);
  }
  return action;
}

function ensureStoreDir(storeDir: string): void {
  if (!safeExistsSync(storeDir)) {
    safeMkdir(storeDir, { recursive: true });
  }
}

function declarationPath(storeDir: string, id: string): string {
  return path.join(storeDir, `${assertValidId(id)}.json`);
}

function readDeclaration(storeDir: string, id: string): ScheduleDeclaration {
  const filePath = declarationPath(storeDir, id);
  if (!safeExistsSync(filePath)) {
    throw new Error(`scheduler-actuator: no schedule found for id '${id}'`);
  }
  return readJson<ScheduleDeclaration>(filePath);
}

export function listDeclarations(storeDir: string): ScheduleDeclaration[] {
  if (!safeExistsSync(storeDir)) return [];
  const declarations: ScheduleDeclaration[] = [];
  for (const entry of safeReaddir(storeDir)) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(storeDir, entry);
    try {
      declarations.push(readJson<ScheduleDeclaration>(filePath));
    } catch (error: unknown) {
      logger.warn(
        `[scheduler-actuator] skipping unreadable declaration '${entry}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  declarations.sort((a, b) => a.id.localeCompare(b.id));
  return declarations;
}

function generateId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `sch-${Date.now().toString(36)}-${rand}`;
}

function scheduleDeclaration(
  storeDir: string,
  params: NonNullable<SchedulerAction['params']>
): ScheduleDeclaration {
  const cron = validateCron(params.cron as string);
  const id = params.id?.trim() ? assertValidId(params.id) : generateId();
  if (
    typeof params.payload !== 'object' ||
    params.payload === null ||
    Array.isArray(params.payload)
  ) {
    throw new Error('scheduler-actuator: params.payload must be an object');
  }
  ensureStoreDir(storeDir);
  const filePath = declarationPath(storeDir, id);
  const now = new Date().toISOString();
  const previous = safeExistsSync(filePath)
    ? (readJson<ScheduleDeclaration>(filePath) as ScheduleDeclaration)
    : null;
  const declaration: ScheduleDeclaration = {
    id,
    cron,
    payload: params.payload as Record<string, unknown>,
    enabled: params.enabled ?? true,
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };
  safeWriteFile(filePath, JSON.stringify(declaration, null, 2));
  return declaration;
}

export async function handleAction(action: SchedulerAction): Promise<unknown> {
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `scheduler:${action.op}`,
    params: (action.params || {}) as Record<string, unknown>,
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation scheduler:${action.op} was not admitted.`}`
    );
  }
  const valid = validateAction({
    ...action,
    params: preflight.input as SchedulerAction['params'],
  });
  const params = valid.params || {};
  const storeDir = resolveStoreDir();
  const traceCtx = new TraceContext(`scheduler-actuator:${valid.op}`, {
    actuator: 'scheduler-actuator',
  });
  traceCtx.addEvent('action.received', { op: valid.op });
  let result: unknown;
  try {
    switch (valid.op) {
      case 'schedule': {
        result = scheduleDeclaration(storeDir, params);
        break;
      }
      case 'list': {
        result = listDeclarations(storeDir);
        break;
      }
      case 'cancel': {
        const id = assertValidId(params.id as string);
        const filePath = declarationPath(storeDir, id);
        if (!safeExistsSync(filePath)) {
          throw new Error(`scheduler-actuator: no schedule found for id '${id}'`);
        }
        safeUnlinkSync(filePath);
        result = { id, cancelled: true };
        break;
      }
      case 'fire': {
        // Manual trigger: return the stored payload. No daemonization —
        // execution stays with the caller.
        const stored = readDeclaration(storeDir, params.id as string);
        result = {
          id: stored.id,
          cron: stored.cron,
          payload: stored.payload,
          enabled: stored.enabled,
          fired_at: new Date().toISOString(),
        };
        break;
      }
      default: {
        const _exhaustive: never = valid.op;
        throw new Error(`Unsupported operation: ${String(_exhaustive)}`);
      }
    }
    traceCtx.addEvent('action.completed', {
      op: valid.op,
      records: Array.isArray(result) ? result.length : 1,
    });
    logger.debug(`[scheduler-actuator] ${valid.op} completed`);
    return result;
  } catch (error: unknown) {
    const classified = classifyError(error);
    traceCtx.addEvent('action.failed', { op: valid.op, category: classified.category });
    throw error;
  } finally {
    try {
      persistTrace(traceCtx.finalize());
    } catch (_) {
      // Trace persistence is best-effort and must not change the action result.
    }
  }
}
