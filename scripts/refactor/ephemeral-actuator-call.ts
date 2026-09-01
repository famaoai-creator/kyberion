import { capabilityEntry, pathResolver } from '@agent/core/path-resolver';
import { safeExec, safeExistsSync, safeUnlinkSync, safeWriteFile } from '@agent/core/secure-io';

export function invokeActuatorWithTempInput(
  actuatorName: string,
  input: unknown,
  tempPrefix: string
): string {
  const tempPath = pathResolver.sharedTmp(`scripts/${tempPrefix}-${Date.now()}.json`);
  safeWriteFile(tempPath, JSON.stringify(input, null, 2));

  try {
    return safeExec('node', [capabilityEntry(actuatorName), '--input', tempPath]);
  } finally {
    if (safeExistsSync(tempPath)) {
      safeUnlinkSync(tempPath);
    }
  }
}
