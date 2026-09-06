import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import {
  loadConnectionWithFallback,
  loadServiceConnectionAtPath,
  resolveTemplateValue,
  writeServiceConnectionAtPath,
} from './service-engine-helpers.js';

const serviceConnectionPath = pathResolver.sharedTmp(
  `service-connection-loader-${process.pid}.json`
);

afterEach(() => {
  safeRmSync(serviceConnectionPath, { force: true });
});

describe('service-engine-helpers template path tokens', () => {
  it('loads a service connection through the schema-bound catalog', () => {
    safeWriteFile(serviceConnectionPath, JSON.stringify({ base_url: 'https://example.test' }));

    expect(loadServiceConnectionAtPath(serviceConnectionPath)).toEqual({
      base_url: 'https://example.test',
    });
  });

  it('rejects a non-object service connection document', () => {
    safeWriteFile(serviceConnectionPath, JSON.stringify([]));

    expect(() => loadServiceConnectionAtPath(serviceConnectionPath)).toThrow(/Invalid catalog/);
  });

  it('writes a service connection through the schema-bound catalog', () => {
    expect(
      writeServiceConnectionAtPath(serviceConnectionPath, {
        service_id: 'github',
        status: 'proposed',
        credential_ref: null,
      })
    ).toBe(serviceConnectionPath);

    expect(loadServiceConnectionAtPath(serviceConnectionPath)).toMatchObject({
      service_id: 'github',
      status: 'proposed',
    });
  });

  it('rejects a non-object service connection before persisting it', () => {
    expect(() =>
      writeServiceConnectionAtPath(serviceConnectionPath, [] as unknown as Record<string, unknown>)
    ).toThrow(/Invalid catalog service-connection-document/);
  });

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
