/**
 * Plugin: Execution Guard
 *
 * Enforces execution policies:
 * - Blocks skills from running on certain file types
 * - Logs all executions with source context
 * - Enforces a configurable timeout threshold warning
 *
 * Config (via env vars):
 *   GUARD_BLOCKED_EXTS=".exe,.bat,.sh"
 *   GUARD_WARN_DURATION_MS=5000
 */
const fs = require('fs');
const path = require('path');

const BLOCKED_EXTENSIONS = (process.env.GUARD_BLOCKED_EXTS || '').split(',').filter(Boolean);

const WARN_DURATION_MS = parseInt(process.env.GUARD_WARN_DURATION_MS || '5000', 10);

const auditLog = path.join(process.cwd(), 'work', 'execution-audit.jsonl');

module.exports = {
  beforeSkill(skillName, args) {
    // Check for blocked extensions in input arguments
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
  },

  afterSkill(skillName, output) {
    const duration = output.metadata ? output.metadata.duration_ms : 0;

    // Write audit entry
    try {
      const entry = {
        skill: skillName,
        status: output.status,
        duration_ms: duration,
        ts: new Date().toISOString(),
        pid: process.pid,
      };
      fs.mkdirSync(path.dirname(auditLog), { recursive: true });
      fs.appendFileSync(auditLog, JSON.stringify(entry) + '\n');
    } catch (_e) {
      // Silent fail — audit should never break the skill
    }

    // Warn on slow executions
    if (duration > WARN_DURATION_MS) {
      console.error(
        `[ExecutionGuard] WARNING: ${skillName} took ${duration}ms (threshold: ${WARN_DURATION_MS}ms)`
      );
    }
  },
};
