import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeReaddir } from '@agent/core/secure-io';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from '@agent/core/reasoning/reasoning-backend';
import { main } from './org.js';

const ANSWER = {
  name: 'Invoice Reconciler',
  domain: 'finance',
  description:
    'Owns month-end matching of supplier invoices to approved purchase orders, flags mismatches for review and never approves payments itself.',
  persona: 'analyst',
  autonomy_level: 'low',
  required_capabilities: ['analysis', 'invented_capability'],
  allowed_actuators: ['artifact-actuator'],
  tier_access: ['confidential'],
};

const GOVERNED_ROLE_FILES = [
  'knowledge/product/orchestration/team-role-index.json',
  'knowledge/product/governance/authority-role-index.json',
  'knowledge/product/governance/role-authority-map.json',
  'knowledge/product/governance/security-policy.json',
];

function snapshotRoleState(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const file of GOVERNED_ROLE_FILES) {
    snapshot[file] = String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' }));
  }
  snapshot['team-roles/'] = safeReaddir(
    pathResolver.rootResolve('knowledge/product/orchestration/team-roles')
  )
    .sort()
    .join(',');
  snapshot['roles/'] = safeReaddir(pathResolver.rootResolve('knowledge/product/roles'))
    .sort()
    .join(',');
  return snapshot;
}

function useBackend(answer: unknown) {
  const prompt = vi.fn(async () => JSON.stringify(answer));
  registerReasoningBackend({
    ...stubReasoningBackend,
    name: 'test-fake',
    prompt,
  } as ReasoningBackend);
  return prompt;
}

afterEach(() => resetReasoningBackend());

describe('pnpm organization role draft --from-intent', () => {
  it('prints a draft and the confirm command without writing role state', async () => {
    const before = snapshotRoleState();
    const prompt = useBackend(ANSWER);
    const printed: string[] = [];
    await main(
      ['role', 'draft', '--from-intent', 'A role that reconciles vendor invoices monthly.'],
      (value) => printed.push(String(value))
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    const output = printed.join('\n');
    expect(output).toContain('not created — draft only');
    expect(output).toContain('required_capabilities=invented_capability (not_in_inventory)');
    expect(output).toContain(
      "pnpm organization role create --name 'Invoice Reconciler' --domain finance"
    );
    expect(output).toContain('--dry-run');
    expect(output).toContain('--approval-id <approved-request-id>');
    expect(snapshotRoleState()).toEqual(before);
  });

  it('emits the result envelope as JSON with --json', async () => {
    useBackend(ANSWER);
    const printed: string[] = [];
    await main(
      [
        'role',
        'draft',
        '--from-intent',
        'A role that reconciles vendor invoices monthly.',
        '--json',
      ],
      (value) => printed.push(String(value))
    );
    const envelope = JSON.parse(printed.join('\n'));
    expect(envelope.status).toBe('drafted');
    expect(envelope.draft_id).toMatch(/^role-draft-[0-9a-f]{16}$/);
    expect(envelope.draft.required_capabilities).toEqual(['analysis']);
    expect(envelope.next_commands.preview).toContain('--capability analysis');
  });

  it('prints a classified failure and exits non-zero for an overlong intent', async () => {
    const prompt = useBackend(ANSWER);
    const printed: string[] = [];
    await expect(
      main(['role', 'draft', '--from-intent', 'x'.repeat(2001), '--json'], (value) =>
        printed.push(String(value))
      )
    ).rejects.toMatchObject({ name: 'ScriptExitError', code: 1 });
    expect(JSON.parse(printed.join('\n')).failure.class).toBe('intent_too_long');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('requires --from-intent', async () => {
    await expect(main(['role', 'draft'])).rejects.toThrow('--from-intent');
  });
});
