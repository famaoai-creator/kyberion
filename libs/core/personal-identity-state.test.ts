import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  loadPersonalAgentIdentityAtPath,
  loadPersonalIdentityAtPath,
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
});
