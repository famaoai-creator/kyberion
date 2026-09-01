import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync } from './secure-io.js';
import { loadConnectionWithFallback, resolveTemplateValue } from './service-engine-helpers.js';

describe('service-engine-helpers template path tokens', () => {
  it('resolves whole-string path tokens inside template values', () => {
    expect(resolveTemplateValue('{{@shared:tmp/run.json}}', {})).toBe(
      pathResolver.shared('tmp/run.json')
    );
    expect(resolveTemplateValue({ out: '{{@knowledge:product/x.md}}' }, {})).toEqual({
      out: pathResolver.knowledge('product/x.md'),
    });
  });

  it('preserves unknown path token domains', () => {
    expect(resolveTemplateValue('{{@unknown:path}}', {})).toBe('{{@unknown:path}}');
  });

  it('rejects traversal outside the declared path-token domain', () => {
    expect(() => resolveTemplateValue('{{@knowledge:../active/secret}}', {})).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(() => resolveTemplateValue('{{@tmp:/outside}}', {})).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects symlink components in path-token results', () => {
    const suffix = `service-engine-path-token-${process.pid}`;
    const target = pathResolver.sharedTmp(`${suffix}-target`);
    const link = pathResolver.sharedTmp(`${suffix}-link`);
    safeMkdir(target);
    safeSymlinkSync(target, link, 'dir');
    try {
      expect(() => resolveTemplateValue(`{{@tmp:${suffix}-link/file}}`, {})).toThrow(
        '[RESOURCE_PATH_SYMLINK]'
      );
    } finally {
      safeRmSync(link, { recursive: true, force: true });
      safeRmSync(target, { recursive: true, force: true });
    }
  });

  it('rejects a traversal-shaped service id before resolving connection paths', () => {
    expect(() => loadConnectionWithFallback('../active/shared/secret')).toThrow(
      '[SERVICE_ID_INVALID]'
    );
    expect(() => loadConnectionWithFallback('nested/service')).toThrow('[SERVICE_ID_INVALID]');
    expect(() => loadConnectionWithFallback('nested\\service')).toThrow('[SERVICE_ID_INVALID]');
  });
});
