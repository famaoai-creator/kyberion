import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findSensitivePathInText,
  findSensitivePathMatch,
  getSensitivePathRuleIds,
} from './sensitive-path-policy.js';

describe('sensitive-path-policy', () => {
  it('keeps the OH-02 credential registry explicit and unique', () => {
    const ids = getSensitivePathRuleIds();
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['ssh', '~/.ssh/id_ed25519'],
    ['aws', '$HOME/.aws/credentials'],
    ['kube', '${HOME}/.kube/config'],
    ['gnupg', path.join(os.homedir(), '.gnupg/private-keys-v1.d/key.key')],
    ['claude', path.join(os.homedir(), '.claude/.credentials.json')],
    ['codex', path.join(os.homedir(), '.codex/auth.json')],
  ])('matches %s credential paths', (_name, candidate) => {
    expect(findSensitivePathMatch(candidate)?.ruleId).toContain('credential.');
  });

  it('matches Kyberion OAuth storage and shell text while leaving project temp paths alone', () => {
    expect(
      findSensitivePathMatch(path.resolve('knowledge/personal/connections/slack.json'))?.ruleId
    ).toBe('credential.kyberion-connections');
    expect(findSensitivePathMatch(path.resolve('vault/secrets/secrets.json'))?.ruleId).toBe(
      'credential.kyberion-vault'
    );
    expect(findSensitivePathInText('cat ~/.ssh/id_ed25519')?.ruleId).toBe('credential.ssh');
    expect(findSensitivePathMatch(path.resolve('active/shared/tmp/example.txt'))).toBeNull();
  });
});
