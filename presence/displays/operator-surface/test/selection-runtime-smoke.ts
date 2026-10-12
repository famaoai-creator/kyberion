/**
 * Opt-in real-runtime smoke, run centrally after rebuilding @agent/core.
 * Creates only an isolated synthetic KYBERION_ROOT; no production credentials or stores.
 * node --import ./scripts/ts-loader.mjs presence/displays/operator-surface/test/selection-runtime-smoke.ts
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExecutionEnv,
  resolveIdentityContext,
  withExecutionContextAsync,
} from '@agent/core/authority';
import {
  safeReadFile,
  safeWriteFile,
  safeReaddir,
  safeLstat,
  safeMkdir,
  safeRmSync,
  safeExecResultAsync,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { getRegisteredEnvText, writeJson } from '@agent/core/foundation';
import type { OperatorViewer } from '../src/lib/viewer-context';

const missionId = 'MSN-SELECTION-SYNTHETIC';
async function child() {
  assert.equal(
    pathResolver.rootDir(),
    getRegisteredEnvText('KYBERION_ROOT'),
    'isolation root must be active before any service access'
  );
  assert.equal(resolveIdentityContext().role, 'operator_surface');
  const service = await import('../src/lib/selection-service.js');
  const viewer: OperatorViewer = {
    role: 'localadmin',
    source: 'token',
    principalId: 'synthetic-verified-principal',
    credentialSource: 'session-cookie',
    loopback: false,
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential'],
  };
  const statePath = pathResolver.rootResolve(
    'active/missions/public/' + missionId + '/team-composition.json'
  );
  const initialMission = service.getMissionSelectionSnapshot(viewer, missionId);
  const before = safeReadFile(statePath, { encoding: 'utf8' });
  const missionCommand = {
    action: 'preview' as const,
    role: 'implementer',
    selection: {
      mode: 'fixed' as const,
      agent_id: 'fixture-agent',
      provider: 'codex',
      model: 'codex',
    },
    expectedRevision: initialMission.revision,
  };
  const preview = await service.changeMissionSelection(viewer, missionId, missionCommand);
  assert.equal(safeReadFile(statePath, { encoding: 'utf8' }), before, 'preview must not persist');
  assert.equal(preview.rows[0]?.valid, true, JSON.stringify(preview.rows));
  await assert.rejects(
    () =>
      service.changeMissionSelection({ ...viewer, tenantSlugs: ['foreign'] }, missionId, {
        ...missionCommand,
        action: 'save',
        expectedPreviewToken: preview.previewToken,
      }),
    /MISSION_SCOPE_DENIED/
  );
  const saved = await service.changeMissionSelection(viewer, missionId, {
    ...missionCommand,
    action: 'save',
    expectedPreviewToken: preview.previewToken,
  });
  assert.notEqual(saved.revision, initialMission.revision);
  assert.equal(saved.rows[0]?.effective?.agent_id, 'fixture-agent');
  await assert.rejects(
    () =>
      service.changeMissionSelection(viewer, missionId, {
        ...missionCommand,
        action: 'save',
        expectedPreviewToken: preview.previewToken,
      }),
    /STALE/
  );
  const runtime = service.getReasoningSelectionSnapshot(viewer);
  const role = runtime.rows[0]?.role;
  assert.ok(role, 'fixture policy has a reasoning role');
  const reasoningCommand = {
    action: 'save' as const,
    role,
    selection: { mode: 'auto' as const },
    expectedRevision: runtime.revision,
  };
  await assert.rejects(
    () =>
      service.changeReasoningSelection({ ...viewer, projectIds: ['foreign'] }, reasoningCommand),
    /GLOBAL_ADMIN_REQUIRED/
  );
  const runtimePreview = await service.changeReasoningSelection(viewer, {
    ...reasoningCommand,
    action: 'preview',
  });
  assert.equal(
    runtimePreview.rows.find((row) => row.role === role)?.valid,
    true,
    JSON.stringify(runtimePreview.rows)
  );
  assert.equal(
    service.getReasoningSelectionSnapshot(viewer).revision,
    runtime.revision,
    'reasoning preview must not persist'
  );
  const changed = await service.changeReasoningSelection(viewer, reasoningCommand);
  assert.equal(Number(changed.revision), Number(runtime.revision) + 1);
  assert.equal(resolveIdentityContext().role, 'operator_surface', 'save context must not leak');
  process.stdout.write(
    JSON.stringify({
      ok: true,
      role: resolveIdentityContext().role,
      missionPreviewWrites: 0,
      missionSave: true,
      staleRejected: true,
      scopedDenials: true,
      reasoningSave: true,
    }) + '\n'
  );
}

async function parent() {
  const repository = pathResolver.rootDir();
  const root = pathResolver.rootResolve(
    'active/shared/tmp/operator-selection-smoke-' + crypto.randomUUID()
  );
  const copyJson = (relative: string) => {
    const source = path.join(repository, relative);
    const target = path.join(root, relative);
    if (safeLstat(source).isDirectory()) {
      for (const entry of safeReaddir(source)) copyJson(relative + '/' + entry);
    } else if (relative.endsWith('.json')) {
      safeMkdir(path.dirname(target), { recursive: true });
      safeWriteFile(target, safeReadFile(source));
    }
  };
  safeMkdir(root, { recursive: true });
  writeJson(path.join(root, 'package.json'), {
    name: 'operator-selection-synthetic-root',
    private: true,
    type: 'module',
  });
  try {
    // Public product policy/schema copies preserve the real role/tier guard; no grants are invented.
    copyJson('knowledge/product/governance');
    copyJson('knowledge/product/schemas');
    safeWriteFile(
      path.join(root, 'knowledge/product/governance/agent-policies.yaml'),
      safeReadFile(path.join(repository, 'knowledge/product/governance/agent-policies.yaml'))
    );
    for (const file of ['team-role-index.json', 'mission-team-templates.json'])
      copyJson('knowledge/product/orchestration/' + file);
    writeJson(path.join(root, 'knowledge/product/orchestration/agent-profile-index.json'), {
      version: '1.0.0',
      agents: {
        'fixture-agent': {
          authority_roles: ['ecosystem_architect'],
          team_roles: ['implementer'],
          capabilities: ['code', 'implementation', 'refactoring'],
          selection_hints: { preferred_provider: 'codex', preferred_modelId: 'codex' },
          provider_strategy: 'adaptive',
        },
      },
    });
    const dir = path.join(root, 'active/missions/public', missionId);
    safeMkdir(dir, { recursive: true });
    writeJson(path.join(dir, 'mission-state.json'), {
      mission_id: missionId,
      tier: 'public',
      status: 'active',
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'ecosystem_architect',
      confidence_score: 1,
      git: {
        branch: 'synthetic',
        start_commit: 'abc123',
        latest_commit: 'abc123',
        checkpoints: [],
      },
      history: [],
    });
    writeJson(path.join(dir, 'team-composition.json'), {
      mission_id: missionId,
      mission_type: 'development',
      tier: 'public',
      tenant_slug: 'default',
      template: 'development',
      generated_at: new Date().toISOString(),
      assignments: [
        {
          team_role: 'implementer',
          required: true,
          status: 'standby',
          agent_id: 'fixture-agent',
          authority_role: 'ecosystem_architect',
          delegation_contract: null,
          provider: 'codex',
          modelId: 'codex',
          required_capabilities: ['code', 'implementation', 'refactoring'],
          notes: 'Synthetic fixture',
        },
      ],
    });
    writeJson(path.join(root, 'active/shared/runtime/provider-cache.json'), {
      ts: Date.now(),
      providers: [
        {
          provider: 'codex',
          installed: true,
          version: 'synthetic',
          protocol: 'exec',
          models: ['codex', 'gpt-6-sol'],
          capabilities: ['code', 'implementation', 'refactoring', 'reasoning', 'structured_output'],
          healthy: true,
        },
      ],
    });
    // Explicitly clear inherited credentials and authority. safeExec overlays these empty values.
    const cleared = Object.fromEntries(Object.keys(process.env).map((key) => [key, '']));
    const env = buildExecutionEnv(
      {
        ...cleared,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        SYSTEM_ROLE: 'operator_surface',
        KYBERION_ROOT: root,
        KYBERION_REASONING_BACKEND: 'codex-cli',
        MISSION_ID: '',
        KYBERION_TENANT: '',
        KYBERION_PROJECT_ID: '',
        KYBERION_SUDO: '',
      },
      'operator_surface'
    );
    env.KYBERION_PERSONA = '';
    const result = await safeExecResultAsync(
      process.execPath,
      [
        '--import',
        path.join(repository, 'scripts/ts-loader.mjs'),
        fileURLToPath(import.meta.url),
        '--child',
      ],
      { cwd: repository, env, timeoutMs: 120_000 }
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    assert.equal(result.status, 0, 'isolated runtime child must pass');
    assert.match(result.stdout, /"ok":true/);
  } finally {
    safeRmSync(root, { recursive: true, force: true });
  }
}
if (process.argv.includes('--child')) await child();
else await withExecutionContextAsync('ecosystem_architect', parent);
