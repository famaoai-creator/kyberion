import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function makeTempRoot(): string {
  const workspaceRoot = process.cwd();
  const tempBase = path.join(workspaceRoot, 'active', 'shared', 'tmp');
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'kyberion-org-role-'));
  fs.mkdirSync(path.join(root, 'knowledge', 'product', 'governance'), { recursive: true });
  fs.mkdirSync(path.join(root, 'knowledge', 'product', 'orchestration'), { recursive: true });
  fs.mkdirSync(path.join(root, 'knowledge', 'product', 'roles'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'knowledge', 'product', 'governance', 'agent-policies.yaml'),
    [
      'version: "1.0"',
      'policies:',
      '  - name: allow-file-writes',
      '    rules:',
      '      - field: operation',
      '        operator: eq',
      '        value: file_write',
      '        action: allow',
      '        priority: 1',
      '',
    ].join('\n')
  );
  fs.copyFileSync(
    path.join(workspaceRoot, 'knowledge', 'product', 'governance', 'security-policy.json'),
    path.join(root, 'knowledge', 'product', 'governance', 'security-policy.json')
  );
  fs.symlinkSync(path.join(workspaceRoot, 'schemas'), path.join(root, 'schemas'), 'dir');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'kyberion-test', private: true }, null, 2)
  );
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# temp workspace\n');
  return root;
}

describe('org role create', () => {
  it('creates aligned authority, team, policy, and role docs', () => {
    const tempRoot = makeTempRoot();
    const repoRoot = process.cwd();
    const scriptPath = path.join(repoRoot, 'scripts', 'org.ts');
    const loaderPath = path.join(repoRoot, 'scripts', 'ts-loader.mjs');

    try {
      const stdout = execFileSync(
        'node',
        [
          '--import',
          loaderPath,
          scriptPath,
          'role',
          'create',
          '--name',
          'CFO',
          '--domain',
          'leadership',
          '--authority',
          'finance_controller',
          '--persona',
          'analyst',
          '--description',
          'Chief financial officer authority',
          '--ownership-scope',
          'Owns finance governance and planning artifacts.',
          '--capability',
          'budgeting',
          '--capability',
          'forecasting',
          '--scope-class',
          'financial_governance',
          '--write-scope',
          'knowledge/product/governance/finance/',
          '--actuator',
          'artifact-actuator',
          '--tier',
          'public',
          '--tier',
          'confidential',
          '--autonomy',
          'medium',
          '--parent-team-role',
          'owner',
          '--delegate-role',
          'planner',
          '--delegate-role',
          'reviewer',
        ],
        {
          cwd: tempRoot,
          env: {
            ...process.env,
            KYBERION_ROOT: tempRoot,
            KYBERION_PERSONA: 'ecosystem_architect',
          },
          encoding: 'utf8',
        }
      );

      const result = JSON.parse(stdout.trim()) as {
        status: string;
        role_id: string;
        authority_role_id: string;
        persona: string;
      };
      expect(result).toMatchObject({
        status: 'ok',
        role_id: 'cfo',
        authority_role_id: 'finance_controller',
        persona: 'analyst',
      });

      const readText = (relativePath: string) =>
        fs.readFileSync(path.join(tempRoot, relativePath), 'utf8');
      const readJson = <T>(relativePath: string): T => JSON.parse(readText(relativePath)) as T;

      const authorityRole = readJson<{
        role: string;
        description: string;
        default_persona?: string;
        write_scopes: string[];
        scope_classes: string[];
        allowed_actuators: string[];
        tier_access: string[];
      }>('knowledge/product/governance/authority-roles/finance_controller.json');
      expect(authorityRole.role).toBe('finance_controller');
      expect(authorityRole.default_persona).toBe('analyst');
      expect(authorityRole.write_scopes).toContain('knowledge/product/governance/finance/');

      const teamRole = readJson<{
        role: string;
        required_capabilities: string[];
        compatible_authority_roles: string[];
        required_scope_classes: string[];
        autonomy_level: string;
      }>('knowledge/product/orchestration/team-roles/cfo.json');
      expect(teamRole.role).toBe('cfo');
      expect(teamRole.compatible_authority_roles).toEqual(['finance_controller']);
      expect(teamRole.required_capabilities).toEqual(
        expect.arrayContaining(['budgeting', 'forecasting'])
      );

      const roleMap = readJson<{
        context_roles?: Array<{ role: string; authority_role?: string; persona: string }>;
      }>('knowledge/product/governance/role-authority-map.json');
      expect(
        roleMap.context_roles?.some(
          (entry) =>
            entry.role === 'cfo' &&
            entry.authority_role === 'finance_controller' &&
            entry.persona === 'analyst'
        )
      ).toBe(true);

      const policy = readJson<{
        authority_role_permissions?: Record<
          string,
          { allow_read?: string[]; allow_write?: string[] }
        >;
      }>('knowledge/product/governance/security-policy.json');
      expect(policy.authority_role_permissions?.finance_controller?.allow_write).toEqual(
        expect.arrayContaining(['knowledge/product/governance/finance/'])
      );

      const roleWriteAccess = readJson<{
        roles?: Record<string, { allow?: string[] }>;
      }>('knowledge/product/governance/role-write-access.json');
      expect(roleWriteAccess.roles?.finance_controller?.allow).toEqual(
        expect.arrayContaining(['knowledge/product/governance/finance/'])
      );

      const procedure = readText('knowledge/product/roles/cfo/PROCEDURE.md');
      expect(procedure).toContain('Role Procedure: CFO');
      expect(procedure).toContain('finance_controller');

      const mission = readText('knowledge/product/roles/cfo/mission.md');
      expect(mission).toContain('CFO Mission Statement');
      expect(mission).toContain('finance_controller');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('promotes an existing role to explicit act authority', () => {
    const tempRoot = makeTempRoot();
    const repoRoot = process.cwd();
    const scriptPath = path.join(repoRoot, 'scripts', 'org.ts');
    const loaderPath = path.join(repoRoot, 'scripts', 'ts-loader.mjs');

    try {
      execFileSync(
        'node',
        [
          '--import',
          loaderPath,
          scriptPath,
          'role',
          'create',
          '--name',
          'Sales Advisor',
          '--domain',
          'leadership',
          '--authority',
          'strategic_sales',
          '--persona',
          'analyst',
        ],
        {
          cwd: tempRoot,
          env: {
            ...process.env,
            KYBERION_ROOT: tempRoot,
            KYBERION_PERSONA: 'ecosystem_architect',
          },
          encoding: 'utf8',
        }
      );

      const stdout = execFileSync(
        'node',
        [
          '--import',
          loaderPath,
          scriptPath,
          'role',
          'promote',
          '--role',
          'sales_advisor',
          '--authority',
          'strategic_sales',
          '--persona',
          'analyst',
          '--write-scope',
          'active/projects/contracts/',
          '--scope-class',
          'project_delivery',
          '--actuator',
          'artifact-actuator',
          '--tier',
          'confidential',
        ],
        {
          cwd: tempRoot,
          env: {
            ...process.env,
            KYBERION_ROOT: tempRoot,
            KYBERION_PERSONA: 'ecosystem_architect',
          },
          encoding: 'utf8',
        }
      );

      const result = JSON.parse(stdout.trim()) as {
        status: string;
        role_id: string;
        authority_role_id: string;
        persona: string;
        files: { promotion_notes: string };
      };
      expect(result).toMatchObject({
        status: 'ok',
        role_id: 'sales_advisor',
        authority_role_id: 'strategic_sales',
        persona: 'analyst',
      });
      expect(result.files.promotion_notes).toBe(
        'knowledge/product/roles/sales_advisor/PROMOTION.md'
      );

      const readText = (relativePath: string) =>
        fs.readFileSync(path.join(tempRoot, relativePath), 'utf8');
      const readJson = <T>(relativePath: string): T => JSON.parse(readText(relativePath)) as T;

      const authorityRole = readJson<{
        write_scopes: string[];
        scope_classes: string[];
        allowed_actuators: string[];
        tier_access: string[];
      }>('knowledge/product/governance/authority-roles/strategic_sales.json');
      expect(authorityRole.write_scopes).toContain('active/projects/contracts/');
      expect(authorityRole.tier_access).toContain('confidential');

      const teamRole = readJson<{ compatible_authority_roles: string[] }>(
        'knowledge/product/orchestration/team-roles/sales_advisor.json'
      );
      expect(teamRole.compatible_authority_roles).toEqual(
        expect.arrayContaining(['strategic_sales'])
      );

      const roleMap = readJson<{
        context_roles?: Array<{ role: string; authority_role?: string; persona: string }>;
      }>('knowledge/product/governance/role-authority-map.json');
      expect(
        roleMap.context_roles?.some(
          (entry) => entry.role === 'sales_advisor' && entry.authority_role === 'strategic_sales'
        )
      ).toBe(true);

      const promotionNotes = readText('knowledge/product/roles/sales_advisor/PROMOTION.md');
      expect(promotionNotes).toContain('explicit advise-to-act promotion');
      expect(promotionNotes).toContain('strategic_sales');

      const promotedRoleWriteAccess = readJson<{
        roles?: Record<string, { allow?: string[] }>;
      }>('knowledge/product/governance/role-write-access.json');
      expect(promotedRoleWriteAccess.roles?.strategic_sales?.allow).toEqual(
        expect.arrayContaining(['active/projects/contracts/'])
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
