import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('media-actuator security boundary', () => {
  it('keeps production entrypoints free of raw node:fs imports', () => {
    const files = [
      pathResolver.rootResolve('libs/actuators/media-actuator/src/index.ts'),
      pathResolver.rootResolve('libs/actuators/media-actuator/src/artisan/extraction-engine.ts'),
    ];

    for (const filePath of files) {
      const source = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      expect(source).not.toContain("node:fs");
      expect(source).not.toContain("from 'fs'");
      expect(source).not.toContain('from "fs"');
    }
  });
});
