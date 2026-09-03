import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  loadPersonalAgentIdentityAtPath,
  loadPersonalIdentityAtPath,
  writePersonalAgentIdentityAtPath,
  writePersonalIdentityAtPath,
} from './personal-identity-state.js';
import {
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  withExecutionContext,
} from './index.js';

const fixtureRoot = pathResolver.sharedTmp(`personal-identity-state-${process.pid}`);

describe('personal identity state loaders', () => {
  afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

  it('loads sovereign and agent records through their path-bound catalogs', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(fixtureRoot, { recursive: true });
      const sovereignPath = path.join(fixtureRoot, 'my-identity.json');
      const agentPath = path.join(fixtureRoot, 'agent-identity.json');
      safeWriteFile(sovereignPath, JSON.stringify({ name: 'operator', language: 'ja' }));
      safeWriteFile(agentPath, JSON.stringify({ agent_id: 'agent-1', trust_tier: 'sovereign' }));

      expect(loadPersonalIdentityAtPath(sovereignPath)).toMatchObject({ name: 'operator' });
      expect(loadPersonalAgentIdentityAtPath(agentPath)).toMatchObject({
        agent_id: 'agent-1',
      });
    });
  });

  it('rejects malformed, directory, and symlink records', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(fixtureRoot, { recursive: true });
      const malformedPath = path.join(fixtureRoot, 'malformed.json');
      const directoryPath = path.join(fixtureRoot, 'directory.json');
      const targetPath = path.join(fixtureRoot, 'target.json');
      const linkedPath = path.join(fixtureRoot, 'linked.json');
      safeWriteFile(malformedPath, '[]');
      safeMkdir(directoryPath);
      safeWriteFile(targetPath, JSON.stringify({ agent_id: 'outside' }));
      safeSymlinkSync(targetPath, linkedPath);

      expect(loadPersonalIdentityAtPath(malformedPath)).toBeNull();
      expect(loadPersonalAgentIdentityAtPath(directoryPath)).toBeNull();
      expect(loadPersonalAgentIdentityAtPath(linkedPath)).toBeNull();
    });
  });

  it('writes sovereign and agent records through their schema-bound catalogs', () => {
    withExecutionContext('mission_controller', () => {
      const sovereignPath = path.join(fixtureRoot, 'nested', 'my-identity.json');
      const agentPath = path.join(fixtureRoot, 'nested', 'agent-identity.json');

      expect(writePersonalIdentityAtPath(sovereignPath, { name: 'operator' })).toBe(sovereignPath);
      expect(writePersonalAgentIdentityAtPath(agentPath, { agent_id: 'agent-1' })).toBe(agentPath);
      expect(loadPersonalIdentityAtPath(sovereignPath)).toMatchObject({ name: 'operator' });
      expect(loadPersonalAgentIdentityAtPath(agentPath)).toMatchObject({ agent_id: 'agent-1' });
    });
  });

  it('rejects non-object records before persisting them', () => {
    withExecutionContext('mission_controller', () => {
      expect(() =>
        writePersonalIdentityAtPath(
          path.join(fixtureRoot, 'invalid.json'),
          [] as unknown as Record<string, unknown>
        )
      ).toThrow(/Invalid catalog personal-identity/);
    });
  });
});
