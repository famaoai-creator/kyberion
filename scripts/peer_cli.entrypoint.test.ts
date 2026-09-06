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

describe('peer operation CLI entrypoints', () => {
  it('returns operation results through the shared printer', () => {
    for (const [name, normalize] of [
      ['peer_conversation.ts', 'normalizePeerConversationArguments'],
      ['peer_collaboration.ts', 'normalizePeerCollaborationArguments'],
    ]) {
      const source = readScript(name);
      expect(source).toContain(`function ${normalize}(args: string[]): string[]`);
      expect(source).toContain('print(result);');
      expect(source).toContain('dryRun, check, print');
      expect(source).toContain('options.dryRun === true || options.check === true');
      if (name === 'peer_conversation.ts') {
        expect(source).toContain('savePeerConversationSession(session);');
      }
      expect(source).not.toContain('flags: []');
      expect(source).not.toContain('console.log(');
      expect(source).not.toContain('logger.success(');
    }
  });
});
