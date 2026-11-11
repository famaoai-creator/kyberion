/**
 * S4 (concept model v2 D6, "Execution Persona の廃止"): the stored record and
 * input field names that still said `persona` move to the base-role / Org Role
 * names. Writers and readers move together; the old name is read for one
 * release. No reader result may change for a record or input in the old format.
 *
 * The "before" table (tests/fixtures/base-role-record-fields-equivalence.json)
 * was recorded on f12d37fd4, while every writer still wrote the old names:
 * - `pipeline`: for each case, the raw `run_started` journal line the journal
 *   writer produced (`execution_authority.persona`,
 *   `library_execution.identity.persona`), and what the two resume paths derive
 *   from the journal reader's result — the approval-resume child env
 *   (`buildSystemRoleLaunchEnv(…, system_role, { missionRole, <base role> })`,
 *   pipeline-approval-resume.ts) and the role / base role a library resume runs
 *   under (`withExecutionContextAsync(identity.role, …, <identity base role>)`,
 *   pipeline-execution-part-results.ts `resumeLibraryPipelineRun`);
 * - `authn`: the agent-context provider's eligibility and resolved principal
 *   for in-process `executionContext` inputs carrying `persona`;
 * - `team_plan`: what `loadMissionTeamPlanAtPath` returns for a stored team plan
 *   carrying `assigned_persona` (the Org Role).
 * The suite replays the stored raw records / inputs through the current readers.
 *
 * Re-record (never to hide a difference):
 *   KYBERION_RECORD_BASE_ROLE_RECORD_FIELDS=1 pnpm exec vitest run libs/core/testing/base-role-record-fields-equivalence.test.ts
 * then copy active/shared/tmp/base-role-record-fields-equivalence.json over the fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  buildSystemRoleLaunchEnv,
  resolveExecutionBaseRole,
  resolveRole,
  withExecutionContextAsync,
} from '../authority.js';
import type { BaseRole } from '../types.js';
import {
  createPipelineRunJournal,
  pipelineRunJournalPath,
  readPipelineRunJournal,
  type PipelineRunJournalState,
} from '../pipeline/pipeline-run-journal.js';
import { capturePipelineResumePolicyEnvironment } from '../pipeline/pipeline-resume-policy-env.js';
import { listAuthnProviders, type AuthnRequest } from '../authn/authn-principal-resolver.js';
import '../authn/authn-providers.js';
import { resetAgentIdentityServiceForTests } from '../agent/agent-identity.js';
import { clearNhiActorVerificationCache } from '../agent/nhi-actor-verification.js';
import { loadMissionTeamPlanAtPath } from '../mission/mission-team-plan-composer.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';

const FIXTURE = 'tests/fixtures/base-role-record-fields-equivalence.json';
const recording = process.env.KYBERION_RECORD_BASE_ROLE_RECORD_FIELDS === '1';
const TMP_DIR = `active/shared/tmp/base-role-record-fields-${process.pid}`;

const ENV_KEYS = [
  'KYBERION_BASE_ROLE',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_DELEGATED_ROLE',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'MISSION_ID',
] as const;

// ---------------------------------------------------------------------------
// pipeline run records
// ---------------------------------------------------------------------------

interface PipelineCase {
  id: string;
  env: { SYSTEM_ROLE?: string; MISSION_ROLE?: string; KYBERION_BASE_ROLE?: string };
  library?: { role: string; baseRole?: string };
}

const PIPELINE_CASES: PipelineCase[] = [
  {
    id: 'mission-worker',
    env: { MISSION_ROLE: 'mission_controller', KYBERION_BASE_ROLE: 'worker' },
  },
  {
    id: 'mission-sovereign',
    env: { MISSION_ROLE: 'mission_controller', KYBERION_BASE_ROLE: 'sovereign' },
  },
  { id: 'mission-no-base-role', env: { MISSION_ROLE: 'mission_controller' } },
  {
    id: 'system-analyst',
    env: {
      SYSTEM_ROLE: 'concierge',
      MISSION_ROLE: 'chronos_operator',
      KYBERION_BASE_ROLE: 'analyst',
    },
  },
  {
    id: 'library-worker',
    env: { MISSION_ROLE: 'mission_controller', KYBERION_BASE_ROLE: 'worker' },
    library: { role: 'mission_controller', baseRole: 'worker' },
  },
  {
    id: 'library-ecosystem-architect',
    env: { MISSION_ROLE: 'mission_controller', KYBERION_BASE_ROLE: 'ecosystem_architect' },
    library: { role: 'mission_controller', baseRole: 'ecosystem_architect' },
  },
  {
    id: 'library-no-base-role',
    env: { MISSION_ROLE: 'mission_controller' },
    library: { role: 'mission_controller' },
  },
];

interface PipelineDerived {
  resume_env: Record<string, string>;
  library_scope: { role: string; base_role: string } | null;
}

interface PipelineRow extends PipelineDerived {
  raw_run_started: Record<string, unknown>;
}

async function withCleanEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T) {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The stored execution authority's base role, as the current reader exposes it. */
function storedAuthorityBaseRole(state: PipelineRunJournalState): string {
  return state.started!.execution_authority!.base_role;
}

/** The stored library identity's base role, as the current reader exposes it. */
function storedIdentityBaseRole(state: PipelineRunJournalState): string | undefined {
  return state.started!.library_execution!.identity.base_role;
}

/** What the two resume paths derive from a journal read through the current reader. */
async function derive(state: PipelineRunJournalState): Promise<PipelineDerived> {
  const authority = state.started!.execution_authority!;
  const env = buildSystemRoleLaunchEnv({}, authority.system_role, {
    missionRole: authority.mission_role,
    persona: storedAuthorityBaseRole(state),
  });
  const resume_env = Object.fromEntries(
    [
      'SYSTEM_ROLE',
      'MISSION_ROLE',
      'KYBERION_DELEGATED_ROLE',
      'KYBERION_BASE_ROLE',
      'KYBERION_PERSONA',
    ].map((key) => [key, String(env[key] ?? '')])
  );
  const identity = state.started!.library_execution?.identity;
  const library_scope = identity
    ? await withCleanEnv({}, () =>
        withExecutionContextAsync(
          identity.role,
          () => ({
            role: resolveRole() ?? 'NONE',
            base_role: resolveExecutionBaseRole() ?? 'NONE',
          }),
          storedIdentityBaseRole(state) as BaseRole | undefined,
          identity.tenant_slug,
          identity.organization_id
        )
      )
    : null;
  return { resume_env, library_scope };
}

const createdJournals = new Set<string>();

async function writeJournal(testCase: PipelineCase): Promise<PipelineRunJournalState> {
  const runId = `base-role-equivalence-${testCase.id}-${process.pid}`;
  return withCleanEnv(testCase.env, () => {
    const journal = createPipelineRunJournal(runId, {
      pipeline_id: `equivalence-${testCase.id}`,
      input_path: 'pipelines/example.json',
      step_ids: ['step'],
      ...(testCase.library
        ? {
            library_execution: {
              source_sha256: 'a'.repeat(64),
              initial_context: {},
              payload_scope: { tier: 'public' as const },
              identity: {
                role: testCase.library.role,
                ...(testCase.library.baseRole ? { base_role: testCase.library.baseRole } : {}),
              },
              trust_resolved: false,
            },
          }
        : {}),
    });
    createdJournals.add(journal.path);
    return journal.state();
  });
}

function replayJournal(raw: Record<string, unknown>): PipelineRunJournalState {
  const runId = String(raw.run_id);
  const filePath = pipelineRunJournalPath(runId);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(raw)}\n`);
  createdJournals.add(filePath);
  return readPipelineRunJournal(filePath);
}

type RawShape = 'new' | 'both';

/**
 * The stored old-format line rewritten to the new field name (`new`), or
 * carrying both names with a conflicting legacy value (`both`: the new name
 * must win).
 */
function reshapeRaw(raw: Record<string, unknown>, shape: RawShape): Record<string, unknown> {
  const copy = structuredClone(raw) as {
    run_id: string;
    payload: {
      execution_authority: Record<string, unknown>;
      library_execution?: { identity: Record<string, unknown> };
    };
  };
  copy.run_id = `${copy.run_id}-${shape}`;
  const move = (record: Record<string, unknown>) => {
    if (!('persona' in record)) return;
    record.base_role = record.persona;
    if (shape === 'new') delete record.persona;
    else record.persona = 'sovereign_conflicting_legacy_value';
  };
  move(copy.payload.execution_authority);
  if (copy.payload.library_execution) move(copy.payload.library_execution.identity);
  return copy as unknown as Record<string, unknown>;
}

function rawRunStarted(state: PipelineRunJournalState): Record<string, unknown> {
  const text = safeReadFile(state.path, { encoding: 'utf8' }) as string;
  return JSON.parse(text.split('\n')[0]!) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// authn executionContext
// ---------------------------------------------------------------------------

interface AuthnCase {
  id: string;
  executionContext: Record<string, string>;
}

const AUTHN_LEGACY_CASES: AuthnCase[] = [
  { id: 'persona-worker', executionContext: { persona: 'worker' } },
  { id: 'persona-ecosystem-architect', executionContext: { persona: 'ecosystem_architect' } },
  { id: 'persona-slug', executionContext: { persona: 'release-bot' } },
  { id: 'persona-padded', executionContext: { persona: '  worker  ' } },
  { id: 'persona-blank', executionContext: { persona: '   ' } },
  {
    id: 'persona-and-mission-role',
    executionContext: { persona: 'analyst', missionRole: 'mission_controller' },
  },
  { id: 'mission-role-only', executionContext: { missionRole: 'mission_controller' } },
  {
    id: 'actor-hint-outranks-persona',
    executionContext: { actorHint: 'kyberion://agent/_/_/hinted-agent', persona: 'worker' },
  },
  { id: 'persona-not-slug', executionContext: { persona: 'Not A Slug!' } },
  { id: 'empty', executionContext: {} },
];

type AuthnRow = { eligible: boolean; principal: string | null } | { error: string };

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `THROW:${message.match(/\[([A-Z][A-Z0-9_]+)\]/u)?.[1] ?? message.slice(0, 80)}`;
}

function authnRow(executionContext: Record<string, string>): AuthnRow {
  const provider = listAuthnProviders(['agent-context'])[0]!;
  const request = {
    credential: { type: 'none' },
    serverTenant: 'default',
    executionContext,
  } as AuthnRequest;
  const deps = { env: {} };
  try {
    const eligible = provider.canResolve(request, deps).eligible;
    const principal = provider.resolve(request, deps);
    return { eligible, principal: principal ? principal.principalId : null };
  } catch (error) {
    return { error: errorCode(error) };
  }
}

// ---------------------------------------------------------------------------
// mission team plan
// ---------------------------------------------------------------------------

const TEAM_PLAN_MISSION = 'MSN-BASE-ROLE-EQUIVALENCE';

const TEAM_PLAN_LEGACY_CASES: Array<{ id: string; plan: Record<string, unknown> }> = [
  {
    id: 'assigned-product-manager',
    plan: { assigned_persona: 'product_manager' },
  },
  { id: 'assigned-worker', plan: { assigned_persona: 'worker' } },
  { id: 'unassigned', plan: {} },
];

function teamPlanFile(id: string, plan: Record<string, unknown>): string {
  const dir = pathResolver.rootResolve(`${TMP_DIR}/team-plan-${id}`);
  safeMkdir(dir, { recursive: true });
  const file = path.join(dir, 'team-composition.json');
  safeWriteFile(
    file,
    JSON.stringify({
      mission_id: TEAM_PLAN_MISSION,
      mission_type: 'development',
      tier: 'public',
      template: 'default',
      generated_at: '2026-11-12T00:00:00.000Z',
      assignments: [],
      ...plan,
    })
  );
  return file;
}

function loadTeamPlan(id: string, plan: Record<string, unknown>): unknown {
  try {
    return loadMissionTeamPlanAtPath(teamPlanFile(id, plan), TEAM_PLAN_MISSION);
  } catch (error) {
    return { error: errorCode(error) };
  }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

interface EquivalenceFixture {
  pipeline: Record<string, PipelineRow>;
  authn: Record<string, AuthnRow>;
  team_plan: Record<string, unknown>;
}

function loadFixture(): EquivalenceFixture {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(FIXTURE), { encoding: 'utf8' }) as string
  ) as EquivalenceFixture;
}

beforeEach(() => {
  vi.stubEnv('KYBERION_NHI_ACTOR', 'off');
  resetAgentIdentityServiceForTests(`${TMP_DIR}/agent-identities.jsonl`);
  clearNhiActorVerificationCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearNhiActorVerificationCache();
  resetAgentIdentityServiceForTests();
  for (const file of createdJournals) safeRmSync(file, { force: true });
  createdJournals.clear();
  const dir = pathResolver.rootResolve(TMP_DIR);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
});

describe('base-role record field equivalence (S4)', () => {
  if (recording) {
    it('records the before table', async () => {
      const pipeline: Record<string, PipelineRow> = {};
      for (const testCase of PIPELINE_CASES) {
        const state = await writeJournal(testCase);
        pipeline[testCase.id] = { raw_run_started: rawRunStarted(state), ...(await derive(state)) };
      }
      const authn = Object.fromEntries(
        AUTHN_LEGACY_CASES.map((testCase) => [testCase.id, authnRow(testCase.executionContext)])
      );
      const team_plan = Object.fromEntries(
        TEAM_PLAN_LEGACY_CASES.map((testCase) => [
          testCase.id,
          loadTeamPlan(testCase.id, testCase.plan),
        ])
      );
      const fixture: EquivalenceFixture = { pipeline, authn, team_plan };
      safeWriteFile(
        pathResolver.rootResolve('active/shared/tmp/base-role-record-fields-equivalence.json'),
        `${JSON.stringify(fixture, null, 2)}\n`
      );
    });
    return;
  }

  it('resumes a pipeline record written with the old field names exactly as before', async () => {
    const fixture = loadFixture();
    expect(Object.keys(fixture.pipeline).sort()).toEqual(PIPELINE_CASES.map((c) => c.id).sort());
    for (const [id, row] of Object.entries(fixture.pipeline)) {
      const state = replayJournal(row.raw_run_started);
      expect({ id, ...(await derive(state)) }).toEqual({
        id,
        resume_env: row.resume_env,
        library_scope: row.library_scope,
      });
    }
  });

  it('reads the new field name, and the new name when both are stored', async () => {
    const fixture = loadFixture();
    for (const shape of ['new', 'both'] as const) {
      for (const [id, row] of Object.entries(fixture.pipeline)) {
        const state = replayJournal(reshapeRaw(row.raw_run_started, shape));
        expect(state.started!.execution_authority).not.toHaveProperty('persona');
        expect(state.started!.library_execution?.identity ?? {}).not.toHaveProperty('persona');
        expect({ id, shape, ...(await derive(state)) }).toEqual({
          id,
          shape,
          resume_env: row.resume_env,
          library_scope: row.library_scope,
        });
      }
    }
  });

  it('a record written by the current writer resumes the same as the stored old-format record', async () => {
    const fixture = loadFixture();
    for (const testCase of PIPELINE_CASES) {
      const state = await writeJournal(testCase);
      const written = rawRunStarted(state).payload as {
        execution_authority: Record<string, unknown>;
        library_execution?: { identity: Record<string, unknown> };
      };
      expect(written.execution_authority).not.toHaveProperty('persona');
      expect(written.execution_authority).toHaveProperty('base_role');
      expect(written.library_execution?.identity ?? {}).not.toHaveProperty('persona');
      const row = fixture.pipeline[testCase.id]!;
      expect({ id: testCase.id, ...(await derive(state)) }).toEqual({
        id: testCase.id,
        resume_env: row.resume_env,
        library_scope: row.library_scope,
      });
    }
  });

  it('resolves an old-format authn executionContext exactly as before', () => {
    const fixture = loadFixture();
    for (const testCase of AUTHN_LEGACY_CASES) {
      expect({ id: testCase.id, row: authnRow(testCase.executionContext) }).toEqual({
        id: testCase.id,
        row: fixture.authn[testCase.id],
      });
    }
  });

  it('loads an old-format team plan exactly as before', () => {
    const fixture = loadFixture();
    for (const testCase of TEAM_PLAN_LEGACY_CASES) {
      expect({ id: testCase.id, plan: loadTeamPlan(testCase.id, testCase.plan) }).toEqual({
        id: testCase.id,
        plan: fixture.team_plan[testCase.id],
      });
    }
  });
});
