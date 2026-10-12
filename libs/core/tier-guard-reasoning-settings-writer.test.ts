import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  loadJson,
  safeExecResultAsync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';

const ROLE = 'reasoning_settings_writer';
const CONFIG = 'active/shared/state/reasoning-route-user-config.json';
const GRANTS = [CONFIG, CONFIG + '.previous', CONFIG + '.history/'];
const ROOT = pathResolver.rootDir();
const fixture = pathResolver.sharedTmp('reasoning-settings-role-' + crypto.randomUUID());
const at = (file: string) => path.join(fixture, file);

// The subprocess uses the real authority and secureIO singletons against a fresh
// root. Only immutable product policy/schema inputs are copied into this fixture.
function copyProductDirectory(relative: string): void {
  for (const name of safeReaddir(path.join(ROOT, relative))) {
    const file = path.join(relative, name);
    const source = path.join(ROOT, file);
    const stat = safeLstat(source);
    if (stat.isSymbolicLink()) throw new Error('Unexpected linked product fixture');
    if (stat.isDirectory()) copyProductDirectory(file);
    else if (/\.(?:json|yaml)$/u.test(name)) safeWriteFile(at(file), safeReadFile(source));
  }
}

const child = String.raw`
import { withExecutionContextAsync, resolveIdentityContext, isRoleAssumptionAllowed } from '@agent/core/authority';
import * as io from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { validateReadPermission, validateWritePermission } from '@agent/core/tier-guard';
import * as path from 'node:path';
const expectedRoot = process.argv[1];
if (pathResolver.rootDir() !== expectedRoot) throw new Error('Isolated policy root was not selected');
const config = 'active/shared/state/reasoning-route-user-config.json';
const at = file => path.join(expectedRoot, file);
const blocked = fn => {
  try { fn(); result.diagnostics.push('operation did not throw'); return false; }
  catch (error) { result.diagnostics.push(String(error)); return /ROLE_VIOLATION|SECURITY|POLICY_VIOLATION|SECRET_GUARD|SENSITIVE_PATH_DENIED/.test(String(error)); }
};
const result = {
  diagnostics: [],
  operatorAllowed: isRoleAssumptionAllowed('operator_surface', 'reasoning_settings_writer'),
  unrelatedSystemAllowed: isRoleAssumptionAllowed('slack_bridge', 'reasoning_settings_writer'),
};
await withExecutionContextAsync('reasoning_settings_writer', async () => {
  const identity = resolveIdentityContext();
  result.identity = { persona: identity.persona, role: identity.role };
  result.writes = [config, config + '.previous', config + '.history/1.json'].map(file => {
    if (!validateWritePermission(at(file)).allowed) return false;
    io.safeWriteFile(at(file), 'synthetic reasoning setting');
    return io.safeReadFile(at(file), { encoding: 'utf8' }) === 'synthetic reasoning setting';
  });
  const denied = [
    'active/shared/state/unrelated.json',
    config + '.evil',
    config + '.previous-escape',
    config + '.history-other/1.json',
    config + '.history/../unrelated.json',
    'knowledge/personal/connections/fixture.json',
    'knowledge/product/governance/security-policy.json',
  ];
  result.deniedWrites = denied.map(file => {
    const decision = validateWritePermission(at(file));
    result.diagnostics.push(JSON.stringify({ file, decision }));
    return !decision.allowed && blocked(() => io.safeWriteFile(at(file), 'denied'));
  });
  const credential = at('knowledge/personal/connections/fixture.json');
  result.diagnostics.push(JSON.stringify({ credentialRead: validateReadPermission(credential) }));
  result.credentialReadDenied = !validateReadPermission(credential).allowed &&
    blocked(() => io.safeReadFile(credential, { encoding: 'utf8' }));
  result.symlinkWriteDenied = blocked(() =>
    io.safeWriteFile(at(config + '.history/escape/target.json'), 'denied')
  );
  result.symlinkReadDenied = blocked(() =>
    io.safeReadFile(at(config + '.history/private-link.json'), { encoding: 'utf8' })
  );
  // These paths are existing default/worker rights; the new role must retain them.
  const inherited = at('active/shared/tmp/inherited-worker.txt');
  io.safeWriteFile(inherited, 'existing worker permission');
  result.inheritedWorkerWrite = io.safeReadFile(inherited, { encoding: 'utf8' }) === 'existing worker permission';
});
process.stdout.write('\nREASONING_ROLE_POLICY_RESULT=' + JSON.stringify(result) + '\n');
`;

type Result = {
  diagnostics: string[];
  operatorAllowed: boolean;
  unrelatedSystemAllowed: boolean;
  identity: { persona: string; role: string };
  writes: boolean[];
  deniedWrites: boolean[];
  credentialReadDenied: boolean;
  symlinkWriteDenied: boolean;
  symlinkReadDenied: boolean;
  inheritedWorkerWrite: boolean;
};
let result: Result;

beforeAll(async () => {
  safeWriteFile(at('package.json'), JSON.stringify({ name: 'reasoning-role-policy-fixture' }));
  copyProductDirectory('knowledge/product/governance');
  copyProductDirectory('knowledge/product/schemas');
  safeMkdir(at(CONFIG + '.history'));
  safeWriteFile(at('active/shared/state/foreign/target.json'), 'unchanged');
  safeWriteFile(at('knowledge/personal/connections/fixture.json'), 'synthetic private fixture');
  safeSymlinkSync(at('active/shared/state/foreign'), at(CONFIG + '.history/escape'));
  safeSymlinkSync(
    at('knowledge/personal/connections/fixture.json'),
    at(CONFIG + '.history/private-link.json')
  );
  const execution = await safeExecResultAsync(
    process.execPath,
    ['--input-type=module', '-e', child, fixture],
    {
      cwd: ROOT,
      timeoutMs: 20_000,
      env: {
        KYBERION_ROOT: fixture,
        SYSTEM_ROLE: 'operator_surface',
        KYBERION_PERSONA: '',
        MISSION_ROLE: '',
        MISSION_ID: '',
        KYBERION_SUDO: 'false',
        KYBERION_SUDO_SCOPE: '',
        KYBERION_DELEGATED_ROLE: '',
        KYBERION_TENANT: '',
        KYBERION_ORGANIZATION_ID: '',
        KYBERION_PROJECT_ID: '',
      },
    }
  );
  expect(execution.status, execution.stderr || execution.error?.message).toBe(0);
  const line = execution.stdout
    .split('\n')
    .find((value) => value.startsWith('REASONING_ROLE_POLICY_RESULT='));
  expect(line).toBeDefined();
  result = JSON.parse(line!.slice('REASONING_ROLE_POLICY_RESULT='.length)) as Result;
}, 30_000);

afterAll(() => safeRmSync(fixture, { recursive: true, force: true }));

describe('reasoning settings writer role boundaries', () => {
  it('adds only the three bounded role grants and no actuator authority', () => {
    const security = loadJson(path.join(ROOT, 'knowledge/product/governance/security-policy.json'));
    expect(security.authority_role_permissions[ROLE]).toEqual({
      allow_read: GRANTS,
      allow_write: GRANTS,
    });
    const index = loadJson(
      path.join(ROOT, 'knowledge/product/governance/authority-role-index.json')
    );
    expect(index.authority_roles[ROLE]).toMatchObject({
      default_persona: 'worker',
      write_scopes: GRANTS,
      allowed_actuators: [],
    });
    const assumptions = loadJson(
      path.join(ROOT, 'knowledge/product/governance/role-assumption-policy.json')
    );
    expect(assumptions.shared_core_roles.roles).not.toContain(ROLE);
    const owners = Object.entries(
      assumptions.system_roles as Record<string, { may_assume: string[] }>
    )
      .filter(([, entry]) => entry.may_assume.includes(ROLE))
      .map(([name]) => name);
    expect(owners).toEqual(['operator_surface']);
  });

  it('assumes a worker persona only from the registered Operator surface', () => {
    expect(result.operatorAllowed).toBe(true);
    expect(result.unrelatedSystemAllowed).toBe(false);
    expect(result.identity).toEqual({ persona: 'worker', role: ROLE });
  });

  it('writes and reads the actual config, previous backup, and history paths', () => {
    expect(result.writes).toEqual([true, true, true]);
    expect(result.inheritedWorkerWrite).toBe(true);
  });

  it('denies unrelated state, prefix siblings, traversal, credentials, and governance writes', () => {
    expect(result.deniedWrites, JSON.stringify(result.diagnostics)).toEqual(Array(7).fill(true));
    expect(result.credentialReadDenied, JSON.stringify(result.diagnostics)).toBe(true);
  });

  it('rejects canonical symlink escapes without modifying the target', () => {
    expect(result.symlinkWriteDenied).toBe(true);
    expect(result.symlinkReadDenied, JSON.stringify(result.diagnostics)).toBe(true);
    expect(safeReadFile(at('active/shared/state/foreign/target.json'), { encoding: 'utf8' })).toBe(
      'unchanged'
    );
  });
});
