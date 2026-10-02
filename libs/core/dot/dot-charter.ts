/**
 * Dot charter — loader and validation for resident-agent ('dot') charters.
 *
 * A dot is a resident agent that holds a standing responsibility across
 * sessions: it wakes on declared triggers, works toward a durable goal via the
 * worker-goal-driver, delegates substantive work as WorkItems, and reaches the
 * accountable human through the notification surface. The charter is the
 * declarative contract — it never grants authority, it references an existing
 * authority role from security-policy.json.
 *
 * Layout mirrors the pipeline convention: repo-level charters live in `dots/`,
 * tenant-scoped charters in `knowledge/confidential/{tenant}/dots/` (scanned
 * and executed by the tenant-bound runner, same as scheduled pipelines).
 */

import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeLstat, safeReaddir, safeReadFile } from '../secure-io.js';
import { compileSchema } from '../foundation/ajv.js';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import type { ValidateFunction } from 'ajv';

export const DOT_CHARTER_SCHEMA_PATH = 'knowledge/product/schemas/dot-charter.schema.json';
export const DOT_CHARTER_DIR = 'dots';

export type DotCharterStatus = 'draft' | 'active' | 'paused' | 'retired';
export type DotTrigger =
  | { kind: 'cron'; cron: string; timezone?: string }
  | { kind: 'watch'; paths: string[] }
  | { kind: 'wake'; channels: string[] };

export interface DotCharter {
  kind: 'dot-charter';
  dot_id: string;
  version: string;
  title: string;
  purpose: string;
  status: DotCharterStatus;
  scope: {
    tier: 'public' | 'confidential' | 'personal';
    tenant_slug?: string;
    organization_id?: string;
    project_id?: string;
  };
  goal: {
    statement: string;
    success_signals?: string[];
    budget?: {
      max_turns_per_wake?: number;
      wall_clock_ms_per_wake?: number;
      token_cap_per_day?: number;
    };
  };
  attention: { triggers: DotTrigger[] };
  authority: {
    authority_role: string;
    accountability_charter_ref?: string;
    allowed_work_shapes?: Array<'mission' | 'task_session' | 'pipeline' | 'direct_reply'>;
    max_concurrent_delegations?: number;
  };
  decisions?: {
    default_decision?: 'auto' | 'notify' | 'approve';
    veto_window_minutes?: number;
    escalate_channel?: 'slack' | 'telegram' | 'discord' | 'imessage' | 'surface';
  };
  notification: {
    deliver_to: {
      surface: 'slack' | 'telegram' | 'discord' | 'imessage' | 'surface';
      channel: string;
      thread_ts?: string;
      template?: string;
    };
    digest_cron?: string;
    quiet_hours?: { start?: string; end?: string; timezone?: string };
  };
  runtime: {
    heartbeat_id: string;
    reasoning_backend?: string;
    max_idle_wake_ms?: number;
  };
}

let validator: ValidateFunction<DotCharter> | undefined;

function charterValidator(): ValidateFunction<DotCharter> {
  validator ||= compileSchema<DotCharter>(pathResolver.rootResolve(DOT_CHARTER_SCHEMA_PATH));
  return validator;
}

export function validateDotCharter(value: unknown, sourcePath = '<inline>'): DotCharter {
  const candidate =
    value && typeof value === 'object' && !Array.isArray(value) && '$schema' in value
      ? Object.fromEntries(Object.entries(value as object).filter(([key]) => key !== '$schema'))
      : value;
  const validate = charterValidator();
  if (!validate(candidate)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim())
      .join('; ');
    throw new Error(`Invalid dot charter at ${sourcePath}: ${errors}`);
  }
  return candidate as DotCharter;
}

export function loadDotCharter(filePath: string): DotCharter {
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = parseSafeJsonObjectInput(raw, `dot charter ${filePath}`);
  return validateDotCharter(parsed, filePath);
}

/** Repo-level charter dir; tenant charters live under knowledge/confidential/<slug>/dots. */
export function dotCharterDir(rootDir = pathResolver.rootDir()): string {
  return path.join(rootDir, DOT_CHARTER_DIR);
}

export function listDotCharterPaths(rootDir = pathResolver.rootDir()): string[] {
  const dir = dotCharterDir(rootDir);
  if (!safeExistsSync(dir)) return [];
  const found: string[] = [];
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    const stat = safeLstat(full);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    found.push(full);
  }
  return found.sort();
}

export interface LoadedDotCharter {
  path: string;
  charter: DotCharter;
}

export function listDotCharters(
  rootDir = pathResolver.rootDir(),
  options: { status?: DotCharterStatus } = {}
): LoadedDotCharter[] {
  const charters: LoadedDotCharter[] = [];
  for (const filePath of listDotCharterPaths(rootDir)) {
    const charter = loadDotCharter(filePath);
    if (options.status && charter.status !== options.status) continue;
    charters.push({ path: filePath, charter });
  }
  return charters;
}
