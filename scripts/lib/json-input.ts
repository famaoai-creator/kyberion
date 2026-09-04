export {
  parseSafeJsonInput,
  parseSafeJsonObjectInput,
  parseSafeJsonObjectValue,
} from '@agent/core/foundation';

import { parseSafeJsonInput, parseSafeJsonObjectValue } from '@agent/core/foundation';
import { safeExistsSync, safeLstat, safeReadFile } from '@agent/core/secure-io';

/** Read a repository or runtime JSON artifact only after its file boundary is verified. */
export function readSafeJsonFile<T>(filePath: string, label: string): T {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return parseSafeJsonObjectValue(
    parseSafeJsonInput(String(safeReadFile(filePath, { encoding: 'utf8' }) || ''), label),
    label
  ) as T;
}
