import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('media-actuator security boundary', () => {
  it('keeps production entrypoints free of raw node:fs imports', () => {
    const files = [
      pathResolver.rootResolve('libs/actuators/media-actuator/src/index.ts'),
      pathResolver.rootResolve('libs/actuators/media-actuator/src/artisan/extraction-engine.ts'),
    ];

    for (const filePath of files) {
      const source = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      expect(source).not.toContain('node:fs');
      expect(source).not.toContain("from 'fs'");
      expect(source).not.toContain('from "fs"');
    }
  });

  it('revalidates the document layout catalog before reading it', () => {
    const source = safeReadFile(
      pathResolver.rootResolve(
        'libs/actuators/media-actuator/src/media-document-pipeline-helpers.ts'
      ),
      { encoding: 'utf8' }
    ) as string;
    expect(source).toContain('const catalogPath = assertSafeRepositoryPath(');
    expect(source).toContain('loadJson<{');
  });
});
