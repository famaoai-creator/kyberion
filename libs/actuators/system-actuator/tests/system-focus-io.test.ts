import focusTargetStoreSchema from '../../../../knowledge/product/schemas/focus-target-store.schema.json';
import type { FoundationIo } from '@agent/core/foundation';

export async function installFocusTargetStoreTestIo(deps: {
  loadJson: (filePath: string) => unknown;
  safeReadFile: (filePath: string) => unknown;
  safeWriteFile: (filePath: string, content: string) => void;
  safeExistsSync: (filePath: string) => boolean;
}): Promise<void> {
  const foundation = await import('@agent/core/foundation');
  const io: FoundationIo = {
    loadJson: <T>(filePath: string): T =>
      String(filePath).endsWith('/focus-target-store.schema.json')
        ? (focusTargetStoreSchema as T)
        : (deps.loadJson(filePath) as T),
    loadJsonIfPresent: <T>(filePath: string): T | null => {
      try {
        return deps.loadJson(filePath) as T;
      } catch {
        return null;
      }
    },
    appendFile: () => undefined,
    exists: deps.safeExistsSync,
    readFile: (filePath) => String(deps.safeReadFile(filePath)),
    stat: () => ({ mtimeMs: 0, size: 0 }),
    writeFile: deps.safeWriteFile,
  };
  foundation.registerFoundationIo(io);
}
