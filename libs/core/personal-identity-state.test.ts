import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  loadPersonalAgentIdentityAtPath,
  loadPersonalIdentityAtPath,
  writePersonalAgentIdentityAtPath,
  writePersonalIdentityAtPath,
  personalAgentIdentityRevision,
  readPersonalAgentIdentityStrictAtPath,
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

  it('rejects stale profile writes and preserves bindings during same-persona re-onboarding', () => {
    withExecutionContext('mission_controller', () => {
      const file = path.join(fixtureRoot, 'agent-identity.json');
      const bindings = {
        version: 1,
        persona_id: 'haru',
        accountable_human_id: 'user:owner',
        personal_nhi_id: 'kyberion://agent/personal/haru',
        tenant_bindings: [],
      };
      writePersonalAgentIdentityAtPath(file, {
        agent_id: 'haru',
        persona_identity_bindings: bindings,
      });
      const old = personalAgentIdentityRevision(readPersonalAgentIdentityStrictAtPath(file));
      writePersonalAgentIdentityAtPath(file, { agent_id: 'haru', display_name: 'Updated' }, old);
      expect(readPersonalAgentIdentityStrictAtPath(file)?.persona_identity_bindings).toEqual(
        bindings
      );
      expect(() =>
        writePersonalAgentIdentityAtPath(file, { agent_id: 'haru', display_name: 'Stale' }, old)
      ).toThrow(/profile changed/);
      expect(() => writePersonalAgentIdentityAtPath(file, { agent_id: 'renamed' })).toThrow(
        /clear persona bindings/
      );
      expect(readPersonalAgentIdentityStrictAtPath(file)?.agent_id).toBe('haru');
    });
  });

  it('strict reads distinguish missing from malformed profiles', () => {
    withExecutionContext('mission_controller', () => {
      const file = path.join(fixtureRoot, 'agent-identity.json');
      expect(readPersonalAgentIdentityStrictAtPath(file)).toBeNull();
      safeMkdir(fixtureRoot, { recursive: true });
      safeWriteFile(file, '{invalid');
      expect(() => readPersonalAgentIdentityStrictAtPath(file)).toThrow();
    });
  });
});
