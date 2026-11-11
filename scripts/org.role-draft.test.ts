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
import { main as organizationMain } from './organization.js';

// Hermetic: never probe the host's actuator prerequisites.
const DEPS = { probeActuator: async () => ({ available: true, prerequisites: [] }) };

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
  snapshot['authority-roles/'] = safeReaddir(
    pathResolver.rootResolve('knowledge/product/governance/authority-roles')
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
      (value) => printed.push(String(value)),
      DEPS
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    const output = printed.join('\n');
    expect(output).toContain('not created — draft only');
    expect(output).toContain('required_capabilities=invented_capability (not_in_inventory)');
    expect(output).toContain(
      "pnpm organization role create --name 'Invoice Reconciler' --team-role-id invoice_reconciler --authority invoice_reconciler --domain finance"
    );
    // The template-merged grant is shown, not only the drafted values.
    expect(output).toContain('Effective grant on confirm');
    expect(output).toMatch(/tiers: +confidential, public/);
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
      (value) => printed.push(String(value)),
      DEPS
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

  it('requires a --from-intent value that is not another flag', async () => {
    await expect(main(['role', 'draft'])).rejects.toThrow('--from-intent');
    await expect(main(['role', 'draft', '--from-intent'])).rejects.toThrow('requires a value');
    await expect(main(['role', 'draft', '--from-intent', '--json'])).rejects.toThrow(
      'requires a value'
    );
  });

  it('suffixes a drafted id that exists only in the role-authority map and role docs', async () => {
    // solution_architect has no team or authority role file, but role create
    // would still rewrite its role-authority-map entry and its role docs.
    useBackend({ ...ANSWER, name: 'Solution Architect', team_role_id: 'solution_architect' });
    const printed: string[] = [];
    await main(
      ['role', 'draft', '--from-intent', 'A role that designs solutions for customers.', '--json'],
      (value) => printed.push(String(value)),
      DEPS
    );
    const envelope = JSON.parse(printed.join('\n'));
    expect(envelope.draft.team_role_id).toBe('solution_architect_2');
    expect(envelope.next_commands.preview).toContain('--team-role-id solution_architect_2');
  });

  it('role create refuses an explicit --team-role-id that names an existing role unless --update', async () => {
    const base = ['role', 'create', '--name', 'Solution Architect', '--domain', 'default'];
    await expect(
      main([...base, '--team-role-id', 'solution_architect', '--dry-run'])
    ).rejects.toThrow("--team-role-id 'solution_architect' already names an existing role");
    const before = snapshotRoleState();
    const printed: string[] = [];
    await main(
      [...base, '--team-role-id', 'solution_architect', '--update', '--dry-run'],
      (value) => printed.push(String(value))
    );
    expect(JSON.parse(printed.join('\n'))).toMatchObject({
      status: 'dry-run',
      role_id: 'solution_architect',
    });
    // Without --team-role-id the historical behaviour is unchanged.
    printed.length = 0;
    await main([...base, '--dry-run'], (value) => printed.push(String(value)));
    expect(JSON.parse(printed.join('\n')).role_id).toBe('solution_architect');
    expect(snapshotRoleState()).toEqual(before);
  });

  it('prints exactly one result through the organization facade', async () => {
    useBackend({ ...ANSWER, allowed_actuators: [] });
    const printed: unknown[] = [];
    await organizationMain(
      [
        'role',
        'draft',
        '--from-intent',
        'A role that reconciles vendor invoices monthly.',
        '--json',
      ],
      (value) => printed.push(value)
    );
    expect(printed).toHaveLength(1);
    expect(JSON.parse(String(printed[0])).status).toBe('drafted');
  });
});
