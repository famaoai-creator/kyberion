import { safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core';
import { appendJsonLine } from '@agent/core/foundation';
import * as path from 'node:path';

/**
 * Plugin: Output Logger
 */

const logFile = pathResolver.resolve('work/plugin-output.log');

export const afterSkill = (skillName: string, output: any) => {
  try {
    const dir = path.dirname(logFile);
    if (!safeExistsSync(dir)) {
      safeMkdir(dir, { recursive: true });
    }
    appendJsonLine(logFile, {
      skill: skillName,
      status: output.status,
      ts: new Date().toISOString(),
    });
  } catch (_e) {
    // Silent fail
  }
};
