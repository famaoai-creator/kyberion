import { execSync } from 'node:child_process';
import * as os from 'node:os';

/**
 * Checks if a given CLI binary exists in the system PATH.
 */
export function checkBinary(bin: string): boolean {
  try {
    const isWindows = os.platform() === 'win32';
    const command = isWindows ? `where ${bin}` : `command -v ${bin}`;
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

export interface PhysicalValidationResult {
  valid: boolean;
  missing: string[];
}

/**
 * Validates a list of required CLI binaries.
 */
export function validatePhysicalDependencies(requiredBins: string[]): PhysicalValidationResult {
  const missing: string[] = [];

  for (const bin of requiredBins) {
    if (!checkBinary(bin)) {
      missing.push(bin);
    }
  }

  return {
    valid: missing.length === 0,
    missing
  };
}
