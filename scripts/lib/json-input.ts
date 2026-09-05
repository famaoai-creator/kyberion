export {
  parseSafeJsonInput,
  parseSafeJsonObjectInput,
  parseSafeJsonObjectValue,
} from '@agent/core/foundation';

import { parseSafeJsonInput, parseSafeJsonObjectValue, readTextFile } from '@agent/core/foundation';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';

/** Read a repository or runtime JSON artifact only after its file boundary is verified. */
export function readSafeJsonValueFile<T>(filePath: string, label: string): T {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return parseSafeJsonInput(readTextFile(filePath), label) as T;
}

/** Read a JSON object after applying the shared file and safe-object boundaries. */
export function readSafeJsonFile<T>(filePath: string, label: string): T {
  return parseSafeJsonObjectValue(readSafeJsonValueFile<unknown>(filePath, label), label) as T;
}
