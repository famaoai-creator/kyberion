import { safeAppendFileSync, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core';
import * as path from 'node:path';

/**
 * Plugin: Execution Guard
 */

const BLOCKED_EXTENSIONS = (process.env.GUARD_BLOCKED_EXTS || '').split(',').filter(Boolean);
const WARN_DURATION_MS = parseInt(process.env.GUARD_WARN_DURATION_MS || '5000', 10);
const auditLog = pathResolver.resolve('work/execution-audit.jsonl');

export const beforeSkill = (skillName: string, args: any) => {
  if (BLOCKED_EXTENSIONS.length > 0) {
    const argStr = typeof args === 'string' ? args : JSON.stringify(args || '');
    for (const ext of BLOCKED_EXTENSIONS) {
      if (argStr.includes(ext)) {
        const msg = `[ExecutionGuard] Blocked: ${skillName} attempted to process ${ext} file`;
        console.error(msg);
        throw new Error(msg);
      }
    }
  }
};

export const afterSkill = (skillName: string, output: any) => {
  const duration = output.metadata ? output.metadata.duration_ms : 0;

  try {
    const entry = {
      skill: skillName,
      status: output.status,
      duration_ms: duration,
      ts: new Date().toISOString(),
      pid: process.pid,
    };
    const dir = path.dirname(auditLog);
    if (!safeExistsSync(dir)) {
      safeMkdir(dir, { recursive: true });
    }
    safeAppendFileSync(auditLog, JSON.stringify(entry) + '\n');
  } catch (_e) {
    // Silent fail
  }

  if (duration > WARN_DURATION_MS) {
    console.error(
      `[ExecutionGuard] WARNING: ${skillName} took ${duration}ms (threshold: ${WARN_DURATION_MS}ms)`
    );
  }
};
