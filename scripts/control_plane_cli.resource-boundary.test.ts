import { describe, expect, it } from 'vitest';
import { resolveArtifactLibraryResource } from './control_plane_cli.js';

describe('control plane catalog resource boundary', () => {
  it('keeps catalog-relative resources inside the repository', () => {
    expect(() => resolveArtifactLibraryResource('/tmp/outside.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });
});
