import * as path from 'node:path';
import * as readline from 'node:readline';
import AjvModule from 'ajv';
import AjvFormats from 'ajv-formats';
import chalk from 'chalk';
import {
  customerResolver,
  ensureDefaultTenantProfile,
  compileSchemaFromPath,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  withExecutionContext,
  withLock,
} from '@agent/core';
import { createCustomer } from './customer_create.js';
import { switchCustomer } from './customer_switch.js';

const AjvCtor: any = (AjvModule as any).default || (AjvModule as any);
const addFormats: any = (AjvFormats as any).default || AjvFormats;
const onboardingStateAjv = new AjvCtor({ allErrors: true });
addFormats(onboardingStateAjv);
const onboardingStateValidate = compileSchemaFromPath(
  onboardingStateAjv,
  pathResolver.rootResolve('knowledge/public/schemas/onboarding-state.schema.json'),
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

type OnboardingPhase = 'identity' | 'services' | 'tenants' | 'tutorial' | 'summary';
type OnboardingStatus = 'draft' | 'complete';
type ServiceStatus = 'pending' | 'saved' | 'skipped';

interface IdentityDraft {
  name: string;
  language: string;
  interaction_style: 'Senior Partner' | 'Concierge' | 'Minimalist';
  primary_domain: string;
  vision: string;
  agent_id: string;
}

interface ServiceCandidateDraft {
  service_id: string;
  status: ServiceStatus;
  connection_kind?: 'base_url' | 'output_dir' | 'cli_path' | 'custom' | 'none';
  base_url?: string;
  output_dir?: string;
  cli_path?: string;
  notes?: string;
  captured_at: string;
}

interface TenantDraft {
  tenant_slug: string;
  tenant_id?: string;
  display_name: string;
  status: 'active' | 'suspended' | 'archived';
  assigned_role: string;
  purpose?: string;
  created_at: string;
}

interface TutorialDraft {
  mode: 'simulate' | 'apply' | 'skipped';
  summary?: string;
  plan_path?: string;
}

interface OnboardingState {
  version: '1.0.0';
  status: OnboardingStatus;
  current_phase: OnboardingPhase;
  completed_phases: OnboardingPhase[];
  created_at: string;
  updated_at: string;
  identity?: IdentityDraft;
  services?: { candidates: ServiceCandidateDraft[] };
  tenants?: { entries: TenantDraft[] };
  tutorial?: TutorialDraft;
}

const DEFAULT_SERVICES = ['comfyui', 'whisper', 'tts', 'meeting'] as const;
const PHASES: OnboardingPhase[] = ['identity', 'services', 'tenants', 'tutorial', 'summary'];
function profileRoot(): string {
  return customerResolver.customerRoot('') ?? pathResolver.knowledge('personal');
}

function onboardingRoot(): string {
  return path.join(profileRoot(), 'onboarding');
}

function statePath(): string {
  return path.join(onboardingRoot(), 'onboarding-state.json');
}

function summaryPath(): string {
  return path.join(onboardingRoot(), 'onboarding-summary.md');
}

function identityPath(): string {
  return path.join(profileRoot(), 'my-identity.json');
}

function visionPath(): string {
  return path.join(profileRoot(), 'my-vision.md');
}

function agentIdentityPath(): string {
  return path.join(profileRoot(), 'agent-identity.json');
}

function connectionDir(): string {
  return path.join(profileRoot(), 'connections');
}

function tenantDir(): string {
  return path.join(profileRoot(), 'tenants');
}

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

const ask = async (question: string, defaultValue = ''): Promise<string> => {
  if (!interactive) {
    return defaultValue;
  }

  return await new Promise((resolve) => {
    rl.question(question, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue);
    });
  });
};

const normalizeInteractionStyle = (input: string): IdentityDraft['interaction_style'] => {
  const normalized = input.trim().toLowerCase();
  if (normalized.startsWith('s')) return 'Senior Partner';
  if (normalized.startsWith('m')) return 'Minimalist';
  return 'Concierge';
};

const normalizeTenantSlug = (value: string): string => {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9-]{1,30}$/.test(trimmed)) return trimmed;
  throw new Error(`Invalid tenant slug: ${value}`);
};

const isAffirmative = (value: string): boolean => /^(y|yes|true|1|ok|sure|please)$/i.test(value.trim());

const ensureArtifactDir = (filePath: string): void => {
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
};

function assertOnboardingStateSchema(state: OnboardingState): void {
  if (onboardingStateValidate(state)) return;
  const errors = Array.isArray(onboardingStateValidate.errors)
    ? onboardingStateValidate.errors.map((entry: any) => `${entry.instancePath || '/'} ${entry.message || 'invalid'}`).join('; ')
    : 'unknown schema error';
  throw new Error(`[ONBOARDING_STATE_SCHEMA] Invalid onboarding state: ${errors}`);
}

async function writeJsonArtifact(filePath: string, payload: unknown, lockName: string): Promise<void> {
  await withLock(lockName, async () => {
    withExecutionContext('sovereign_concierge', () => {
      ensureArtifactDir(filePath);
      safeWriteFile(filePath, JSON.stringify(payload, null, 2));
    });
  });
}

async function writeTextArtifact(filePath: string, content: string, lockName: string): Promise<void> {
  await withLock(lockName, async () => {
    withExecutionContext('sovereign_concierge', () => {
      ensureArtifactDir(filePath);
      safeWriteFile(filePath, content);
    });
  });
}

function loadState(): OnboardingState | null {
  const filePath = statePath();
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as OnboardingState;
  } catch {
    return null;
  }
}

async function saveState(state: OnboardingState): Promise<void> {
  assertOnboardingStateSchema(state);
  await writeJsonArtifact(statePath(), state, 'onboarding-state');
}

function createInitialState(): OnboardingState {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    status: 'draft',
    current_phase: 'identity',
    completed_phases: [],
    created_at: now,
    updated_at: now,
    services: { candidates: [] },
    tenants: { entries: [] },
    tutorial: { mode: 'skipped' },
  };
}

function buildIdentityFromState(state: OnboardingState): IdentityDraft {
  const existing = state.identity;
  return {
    name: existing?.name || 'Sovereign',
    language: existing?.language || 'Japanese',
    interaction_style: existing?.interaction_style || 'Concierge',
    primary_domain: existing?.primary_domain || 'General',
    vision: existing?.vision || 'Build a high-fidelity Kyberion environment.',
    agent_id: existing?.agent_id || 'KYBERION-PRIME',
  };
}

function buildSummaryMarkdown(state: OnboardingState): string {
  const identity = state.identity;
  const services = state.services?.candidates || [];
  const tenants = state.tenants?.entries || [];
  const tutorial = state.tutorial;

  return [
    '# Kyberion Onboarding Summary',
    '',
    '## Identity',
    `- Name: ${identity?.name || 'n/a'}`,
    `- Language: ${identity?.language || 'n/a'}`,
    `- Style: ${identity?.interaction_style || 'n/a'}`,
    `- Domain: ${identity?.primary_domain || 'n/a'}`,
    `- Vision: ${identity?.vision || 'n/a'}`,
    `- Agent ID: ${identity?.agent_id || 'n/a'}`,
    '',
    '## Services',
    ...(services.length > 0
      ? services.map((entry) => `- ${entry.service_id}: ${entry.status}${entry.connection_kind ? ` (${entry.connection_kind})` : ''}`)
      : ['- None captured yet']),
    '',
    '## Tenants',
    ...(tenants.length > 0
      ? tenants.map((tenant) => `- ${tenant.tenant_slug}: ${tenant.display_name} [${tenant.assigned_role}]`)
      : ['- None registered yet']),
    '',
    '## Tutorial',
    `- Mode: ${tutorial?.mode || 'skipped'}`,
    `- Summary: ${tutorial?.summary || 'n/a'}`,
    '',
    '## Next Steps',
    '- Review candidate service connections before using them in missions.',
    '- Register additional tenants one at a time.',
    '- Convert the tutorial into an explicit mission only after confirming the setup.',
    '',
  ].join('\n');
}

async function runIdentityPhase(state: OnboardingState): Promise<void> {
  console.log('\n🧬 Phase 1 — Identity & Purpose\n');
  const identity = buildIdentityFromState(state);

  identity.name = await ask(`How should I call you? [${identity.name}]: `, identity.name);
  identity.language = await ask(`Preferred language? [${identity.language}]: `, identity.language);
  const styleInput = await ask(`Interaction style (Senior Partner / Concierge / Minimalist) [${identity.interaction_style}]: `, identity.interaction_style);
  identity.interaction_style = normalizeInteractionStyle(styleInput || identity.interaction_style);
  identity.primary_domain = await ask(`Primary domain? [${identity.primary_domain}]: `, identity.primary_domain);
  identity.vision = await ask(`Core vision for this environment? [${identity.vision}]: `, identity.vision);
  identity.agent_id = (await ask(`Agent ID? [${identity.agent_id}]: `, identity.agent_id)).trim().toUpperCase() || 'KYBERION-PRIME';

  state.identity = identity;
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'identity']));
  state.current_phase = 'services';
  state.updated_at = new Date().toISOString();
  await saveState(state);

  await writeJsonArtifact(identityPath(), {
    name: identity.name,
    language: identity.language,
    interaction_style: identity.interaction_style,
    primary_domain: identity.primary_domain,
    created_at: state.created_at,
    status: 'active',
    version: '1.0.0',
  }, 'onboarding-my-identity');

  await writeTextArtifact(visionPath(), `# Sovereign Vision\n\n${identity.vision}\n`, 'onboarding-my-vision');

  await writeJsonArtifact(agentIdentityPath(), {
    agent_id: identity.agent_id,
    version: '1.0.0',
    role: 'Ecosystem Architect / Senior Partner',
    owner: identity.name,
    trust_tier: 'sovereign',
    created_at: state.created_at,
    description: `The primary autonomous entity of the Kyberion Ecosystem for ${identity.name}.`,
  }, 'onboarding-agent-identity');
}

async function promptComfyuiConnection(): Promise<Record<string, unknown> | null> {
  const baseUrl = await ask('ComfyUI base URL [http://127.0.0.1:8188]: ', 'http://127.0.0.1:8188');
  const outputDir = await ask('ComfyUI output dir [optional]: ');
  const notes = await ask('ComfyUI notes [optional]: ');
  if (!baseUrl && !outputDir && !notes) return null;
  return {
    base_url: baseUrl || undefined,
    output_dir: outputDir || undefined,
    notes: notes || undefined,
    source: 'onboarding',
  };
}

async function promptWhisperConnection(): Promise<Record<string, unknown> | null> {
  const whisperkitBaseUrl = await ask('WhisperKit base URL [optional]: ');
  const whisperCliPath = await ask('Whisper CLI path [optional]: ');
  const notes = await ask('Whisper notes [optional]: ');
  if (!whisperkitBaseUrl && !whisperCliPath && !notes) return null;
  return {
    whisperkit_base_url: whisperkitBaseUrl || undefined,
    whisper_cli_path: whisperCliPath || undefined,
    notes: notes || undefined,
    source: 'onboarding',
  };
}

async function promptGenericConnection(serviceId: string): Promise<Record<string, unknown> | null> {
  const baseUrl = await ask(`${serviceId} base URL [optional]: `);
  const outputDir = await ask(`${serviceId} output dir [optional]: `);
  const cliPath = await ask(`${serviceId} CLI path [optional]: `);
  const notes = await ask(`${serviceId} notes [optional]: `);
  if (!baseUrl && !outputDir && !cliPath && !notes) return null;
  return {
    base_url: baseUrl || undefined,
    output_dir: outputDir || undefined,
    cli_path: cliPath || undefined,
    notes: notes || undefined,
    source: 'onboarding',
  };
}

async function runServicesPhase(state: OnboardingState): Promise<void> {
  console.log('\n🔌 Phase 2 — Infrastructure & Services\n');
  const wantsServiceSetup = isAffirmative(await ask('Capture service connection candidates now? (y/N): ', 'n'));
  const candidates: ServiceCandidateDraft[] = [];
  const connDir = connectionDir();
  if (!safeExistsSync(connDir)) safeMkdir(connDir, { recursive: true });

  if (wantsServiceSetup) {
    for (const serviceId of DEFAULT_SERVICES) {
      const wantsThisService = isAffirmative(await ask(`Add ${serviceId} connection now? (y/N): `, 'n'));
      if (!wantsThisService) {
        candidates.push({
          service_id: serviceId,
          status: 'skipped',
          connection_kind: 'none',
          captured_at: new Date().toISOString(),
        });
        continue;
      }

      let payload: Record<string, unknown> | null = null;
      if (serviceId === 'comfyui') {
        payload = await promptComfyuiConnection();
      } else if (serviceId === 'whisper') {
        payload = await promptWhisperConnection();
      } else {
        payload = await promptGenericConnection(serviceId);
      }

      const capturedAt = new Date().toISOString();
      const candidate: ServiceCandidateDraft = {
        service_id: serviceId,
        status: payload ? 'saved' : 'pending',
        connection_kind: payload?.base_url ? 'base_url' : payload?.output_dir ? 'output_dir' : payload?.cli_path ? 'cli_path' : payload ? 'custom' : 'none',
        captured_at: capturedAt,
        ...(payload?.base_url ? { base_url: String(payload.base_url) } : {}),
        ...(payload?.output_dir ? { output_dir: String(payload.output_dir) } : {}),
        ...(payload?.cli_path ? { cli_path: String(payload.cli_path) } : {}),
        ...(payload?.notes ? { notes: String(payload.notes) } : {}),
      };

      candidates.push(candidate);

      if (payload) {
        await writeJsonArtifact(
          path.join(connDir, `${serviceId}.json`),
          {
            service_id: serviceId,
            status: 'draft',
            captured_at: capturedAt,
            ...payload,
          },
          `onboarding-connection-${serviceId}`,
        );
      }
    }
  }

  state.services = { candidates };
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'services']));
  state.current_phase = 'tenants';
  state.updated_at = new Date().toISOString();
  await saveState(state);
}

async function runTenantsPhase(state: OnboardingState): Promise<void> {
  console.log('\n🏢 Phase 3 — Multi-Tenant Registration\n');
  const entries: TenantDraft[] = [];
  const defaultTenant = withExecutionContext(
    'knowledge_steward',
    () => ensureDefaultTenantProfile(),
    'ecosystem_architect',
  );
  const wantsTenantSetup = isAffirmative(await ask('Register a tenant now? (y/N): ', 'n'));
  const tenantDirPath = tenantDir();
  if (!safeExistsSync(tenantDirPath)) safeMkdir(tenantDirPath, { recursive: true });
  entries.push({
    tenant_slug: defaultTenant.tenant_slug,
    tenant_id: defaultTenant.tenant_id,
    display_name: defaultTenant.display_name,
    status: defaultTenant.status,
    assigned_role: defaultTenant.assigned_role,
    created_at: typeof defaultTenant.metadata?.created_at === 'string'
      ? defaultTenant.metadata.created_at
      : new Date().toISOString(),
  });

  if (wantsTenantSetup) {
    let tenantSlug = '';
    while (!tenantSlug) {
      const slugInput = await ask('Tenant slug [e.g. acme-co]: ', '');
      try {
        tenantSlug = normalizeTenantSlug(slugInput);
      } catch (error) {
        console.log(chalk.red(String(error)));
      }
    }
    const displayName = await ask('Tenant display name [required]: ', tenantSlug);
    const assignedRole = await ask('Your role in this tenant [strategist]: ', 'strategist');
    const purpose = await ask('Purpose / scope for this tenant [optional]: ');
    const createdAt = new Date().toISOString();

    const tenantProfile: TenantDraft = {
      tenant_slug: tenantSlug,
      tenant_id: tenantSlug,
      display_name: displayName || tenantSlug,
      status: 'active',
      assigned_role: assignedRole || 'strategist',
      ...(purpose ? { purpose } : {}),
      created_at: createdAt,
    };
    entries.push(tenantProfile);

    await writeJsonArtifact(
      path.join(tenantDirPath, `${tenantSlug}.json`),
      {
        tenant_slug: tenantSlug,
        tenant_id: tenantSlug,
        display_name: tenantProfile.display_name,
        status: tenantProfile.status,
        assigned_role: tenantProfile.assigned_role,
        purpose: purpose || undefined,
        created_at: createdAt,
        isolation_policy: {
          strict_isolation: true,
          allow_cross_distillation: true,
        },
        metadata: {
          onboarding_source: 'pnpm onboard',
        },
      },
      `onboarding-tenant-${tenantSlug}`,
    );
  }

  state.tenants = { entries };
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'tenants']));
  state.current_phase = 'tutorial';
  state.updated_at = new Date().toISOString();
  await saveState(state);
}

async function runTutorialPhase(state: OnboardingState): Promise<void> {
  console.log('\n🎓 Phase 4 — Hands-on Tutorial\n');
  const modeInput = (await ask('Tutorial mode: simulate / apply / skipped [simulate]: ', 'simulate')).trim().toLowerCase();
  const mode: TutorialDraft['mode'] = modeInput === 'apply' ? 'apply' : modeInput === 'skipped' ? 'skipped' : 'simulate';
  const summary = mode === 'skipped'
    ? 'Tutorial skipped during onboarding.'
    : await ask('Describe the first tutorial mission in one sentence: ', 'Demonstrate the initial Kyberion setup with a safe dry-run.');

  const planPath = path.join(onboardingRoot(), 'tutorial-plan.md');
  const planMarkdown = [
    '# Onboarding Tutorial Plan',
    '',
    `- Mode: ${mode}`,
    `- Summary: ${summary}`,
    '',
    '## Suggested next step',
    mode === 'apply'
      ? '- Review the plan and create a mission manually if the setup is ready.'
      : '- Run the tutorial as a dry-run first, then decide whether to promote it to a mission.',
    '',
  ].join('\n');

  await writeTextArtifact(planPath, planMarkdown, 'onboarding-tutorial-plan');

  state.tutorial = { mode, summary, plan_path: planPath };
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'tutorial']));
  state.current_phase = 'summary';
  state.updated_at = new Date().toISOString();
  await saveState(state);
}

async function runSummaryPhase(state: OnboardingState): Promise<void> {
  console.log('\n📊 Phase 5 — Summary\n');
  const summary = buildSummaryMarkdown(state);
  await writeTextArtifact(summaryPath(), summary, 'onboarding-summary');
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'summary']));
  state.status = 'complete';
  state.current_phase = 'summary';
  state.updated_at = new Date().toISOString();
  await saveState(state);

  const identity = state.identity;
  console.log(chalk.green('✅ Onboarding complete.'));
  console.log(`Identity: ${identity?.name || 'Sovereign'} / ${identity?.agent_id || 'KYBERION-PRIME'}`);
  console.log(`Summary written to: ${summaryPath()}`);
  console.log(`State written to: ${statePath()}`);
  console.log('\nNext steps:');
  console.log(`1. Review the service connection drafts in \`${path.join(profileRoot(), 'connections')}/\`.`);
  console.log(`2. Review the tenant draft in \`${path.join(profileRoot(), 'tenants')}/\`.`);
  console.log('3. If the tutorial should become real work, create a mission explicitly after review.');
  console.log('4. Re-run `pnpm surfaces:reconcile` after the workspace is ready.');
}

async function runOnboarding() {
  process.env.MISSION_ROLE = 'sovereign_concierge';
  process.env.KYBERION_PERSONA = 'sovereign';
  const rootDir = pathResolver.rootDir();
  let customerSlug = customerResolver.activeCustomer();

  if (!customerSlug && interactive) {
    const wantsCustomer = isAffirmative(await ask('Set up a customer overlay now? (y/N): ', 'n'));
    if (wantsCustomer) {
      while (!customerSlug) {
        const slugInput = await ask('Customer slug [e.g. acme-corp]: ', '');
        try {
          createCustomer(slugInput);
          switchCustomer(slugInput);
          customerSlug = slugInput.trim();
          process.env.KYBERION_CUSTOMER = customerSlug;
        } catch (error) {
          console.log(chalk.red(String(error)));
        }
      }
    }
  }

  const personalDir = profileRoot();

  if (!interactive && process.env.KYBERION_ONBOARDING_NON_INTERACTIVE_OK !== '1') {
    console.error(chalk.red('\n❌ Refusing to run interactive onboarding without a TTY.'));
    console.error('  This wizard would otherwise silently apply default values for every prompt,');
    console.error('  producing an identity that does not reflect the Sovereign\'s intent.');
    console.error('\n  Options:');
    console.error('    1. Run from a real terminal: pnpm onboard');
    console.error('    2. If you need a customer overlay, create it first with `pnpm customer:create <slug>`');
    console.error('       and activate it with `pnpm customer:switch <slug>` before onboarding.');
    console.error('    3. Use the agent Path B flow (CLAUDE.md → docs/.../onboarding.md): write the');
    console.error(`       active profile root (${profileRoot()}/...) directly per the schemas under`);
    console.error('       knowledge/public/{schemas,templates}.');
    console.error('    4. To intentionally accept defaults, re-run with KYBERION_ONBOARDING_NON_INTERACTIVE_OK=1');
    rl.close();
    process.exit(2);
  }

  console.log('\n🌟 Welcome to Kyberion Sovereign Awakening 🌟\n');
  console.log('This flow captures identity, service readiness, tenant scope, and a safe first tutorial.\n');

  if (!safeExistsSync(personalDir)) {
    safeMkdir(personalDir, { recursive: true });
  }
  if (!safeExistsSync(onboardingRoot())) {
    safeMkdir(onboardingRoot(), { recursive: true });
  }

  let state = loadState();
  if (!state) {
    state = createInitialState();
    await saveState(state);
  } else if (state.status === 'complete') {
    const overwrite = await ask('An onboarding state already exists and is complete. Restart from scratch? (y/N): ', 'n');
    if (!isAffirmative(overwrite)) {
      console.log('Onboarding cancelled. Existing state preserved.');
      rl.close();
      process.exit(0);
    }
    state = createInitialState();
    await saveState(state);
  } else {
    const resume = await ask(`Resume onboarding from phase "${state.current_phase}"? (Y/n): `, 'y');
    if (!isAffirmative(resume)) {
      state = createInitialState();
      await saveState(state);
    }
  }

  for (const phase of PHASES) {
    if (state.completed_phases.includes(phase) && phase !== 'summary') {
      continue;
    }
    if (phase === 'identity') {
      await runIdentityPhase(state);
    } else if (phase === 'services') {
      await runServicesPhase(state);
    } else if (phase === 'tenants') {
      await runTenantsPhase(state);
    } else if (phase === 'tutorial') {
      await runTutorialPhase(state);
    } else if (phase === 'summary') {
      await runSummaryPhase(state);
    }
  }

  console.log('\nWelcome aboard.');
  console.log(`Workspace root: ${rootDir}`);
  rl.close();
}

runOnboarding().catch((err) => {
  console.error('Onboarding failed:', err);
  rl.close();
  process.exit(1);
});
