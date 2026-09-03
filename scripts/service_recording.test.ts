import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './service_recording.js';

describe('service recording entrypoint', () => {
  it('keeps command output and exit policy behind the shared script harness', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/service_recording.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('runServiceRecording = defineScript');
    expect(source).toContain('print(result.value)');
    expect(source).toContain('validateServiceRecording(updated)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('process.exitCode');
  });

  it('returns usage as a value for help without performing a recording action', async () => {
    await expect(main(['help'])).resolves.toMatchObject({
      value: expect.stringContaining('service_recording capture'),
    });
  });

  it('rejects @path JSON input outside the repository', async () => {
    await expect(
      main(['capture', '--target-name', 'boundary-test', '--calls', '@../package.json'])
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });
});
