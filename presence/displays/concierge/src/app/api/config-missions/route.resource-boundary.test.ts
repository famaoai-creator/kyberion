import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('concierge config-missions route resource boundary', () => {
  it('re-checks preset and brief resources before exposing them', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve(
          'presence/displays/concierge/src/app/api/config-missions/route.ts'
        ),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('assertSafeRepositoryPath');
    expect(source).toContain('parseSafeJsonInput(raw, `config mission preset ${name}`)');
    expect(source).not.toContain('JSON.parse(raw)');
    expect(source).toContain('safeLstat(presetPath).isFile()');
    expect(source).toContain('safeLstat(briefPath).isFile()');
    expect(source).not.toContain('safeReadFile(path.join(presetDir, name)');
  });
});
