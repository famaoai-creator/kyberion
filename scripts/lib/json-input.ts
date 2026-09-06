export {
  parseSafeJsonInput,
  parseSafeJsonObjectInput,
  parseSafeJsonObjectValue,
} from '@agent/core/foundation';

import { parseSafeJsonObjectValue, readJson } from '@agent/core/foundation';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';

function readFoundationJson<T>(filePath: string, label: string): T {
  try {
    return readJson<T>(filePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} must be valid JSON`);
    }
    if (error instanceof Error && error.message.includes('dangerous JSON key')) {
      throw new Error(`${label} contains a dangerous JSON key`);
    }
    throw error;
  }
}

/** Read a repository or runtime JSON artifact only after its file boundary is verified. */
export function readSafeJsonValueFile<T>(filePath: string, label: string): T {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return readFoundationJson<T>(filePath, label);
}

/** Read a JSON object after applying the shared file and safe-object boundaries. */
export function readSafeJsonFile<T>(filePath: string, label: string): T {
  return parseSafeJsonObjectValue(readSafeJsonValueFile<unknown>(filePath, label), label) as T;
}
