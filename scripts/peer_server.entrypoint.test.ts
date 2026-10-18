import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

function readScript(name: string): string {
  return String(
    safeReadFile(pathResolver.rootResolve(`scripts/${name}`), {
      encoding: 'utf8',
    })
  );
}

describe('peer server entrypoints', () => {
  it('does not advertise conversation presence before the listener is bound', () => {
    const source = readScript('peer_conversation_server.ts');

    expect(source.indexOf('await server.listen(port, host)')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('await server.listen(port, host)')).toBeLessThan(
      source.indexOf('registerMeshPeer({')
    );
    expect(source).toContain('await server.close();\n    throw error;');
  });

  it('resolves the auto-reply generator from the registry before dry run or listen', () => {
    const source = readScript('peer_conversation_server.ts');
    expect(source).toContain(
      'choices: listIsolatedTextGenerators().map((generator) => generator.id)'
    );
    const resolveAt = source.indexOf('resolveIsolatedTextGenerator(autoReplyOptions.backend)');
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(resolveAt).toBeLessThan(source.indexOf('options.dryRun === true'));
    expect(resolveAt).toBeLessThan(source.indexOf('await server.listen(port, host)'));
    expect(source).not.toContain("'claude', 'codex'");
  });

  it('keeps startup failures in the shared harness boundary', () => {
    for (const name of ['peer_conversation_server.ts']) {
      const source = readScript(name);
      expect(source).not.toContain('process.exitCode');
      expect(source).not.toContain('flags: []');
      expect(source).toContain('stripSharedScriptFlags(args)');
      expect(source).toContain('run: async ({ argv, dryRun, check, print })');
      expect(source).toContain('options.dryRun === true || options.check === true');
      expect(source).toContain('if (result) print(result);');
    }
  });
});
