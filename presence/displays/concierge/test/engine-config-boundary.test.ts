import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { safeReadFile, safeReaddir, safeStat } from '@agent/core/secure-io';

/**
 * The engine runtime operator role writes the personal / stance profile
 * (security-policy: knowledge/personal/). Concierge may assume it
 * only for 設定 › エンジン, so only that route calls the operator module and
 * nothing in Concierge opens an engine-runtime access binding itself.
 */
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(dir: string): string[] {
  return safeReaddir(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (safeStat(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/u.test(entry) && !/\.test\.tsx?$/u.test(entry) ? [full] : [];
  });
}

describe('engine runtime operator boundary', () => {
  it('only the engine-config route uses the operator module or opens an access binding', () => {
    const users = sources(src)
      .filter((file) => {
        const text = String(safeReadFile(file, { encoding: 'utf8' }) ?? '');
        return /from '(?:@agent\/shared-voice\/engine-runtime-preferences-operator|@agent\/core\/voice\/engine-runtime-preferences-(?:operator|access))'/u.test(
          text.replace(/import type [^;]+;/gu, '')
        );
      })
      .map((file) => path.relative(src, file).split(path.sep).join('/'));
    expect(users).toEqual(['app/api/voice/engine-config/route.ts']);
  });
});
