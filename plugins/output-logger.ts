import { safeAppendFileSync, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core';
import * as path from 'node:path';

/**
 * Plugin: Output Logger
 */

const logFile = pathResolver.resolve('work/plugin-output.log');

export const afterSkill = (skillName: string, output: any) => {
  try {
    const line =
      JSON.stringify({ skill: skillName, status: output.status, ts: new Date().toISOString() }) +
      '\n';
    const dir = path.dirname(logFile);
    if (!safeExistsSync(dir)) {
      safeMkdir(dir, { recursive: true });
    }
    safeAppendFileSync(logFile, line);
  } catch (_e) {
    // Silent fail
  }
};
