import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvFormats from 'ajv-formats';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  compileSchemaFromPath,
  loadJson,
  pathResolver,
  resolveActiveProfileRoot,
  resolveOnboardingFlowPolicy,
  resolveOnboardingSummaryPolicy,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  withExecutionContext,
  withLock,
  resolveOnboardingText,
  resolveOperatorLocale,
  isValidTenantSlug,
} from '@agent/core';
import { createAjv } from '@agent/core/foundation';
import {
  evaluateReasoningBackend,
  formatReasoningSummary,
  type OnboardingReasoningState,
} from './onboarding_reasoning.js';
import { generateOnboardingRunbookSkill } from './onboarding_runbook_skill.js';
import {
  normalizeReasoningBackendChoice,
  persistReasoningBackend,
  persistPersona,
  readPersistedPersona,
} from './reasoning_backend_selection.js';

const addFormats: any = (AjvFormats as any).default || AjvFormats;
const ONBOARDING_IDENTITY_EXAMPLE = 'knowledge/public/templates/onboarding/identity.example.json';

interface ApplyInput {
  identity: {
    name: string;
    language: string;
    interaction_style: 'Senior Partner' | 'Concierge' | 'Minimalist';
    primary_domain: string;
    vision: string;
    agent_id: string;
    persona?: 'sovereign' | 'ecosystem_architect' | 'mission_owner' | 'worker' | 'analyst';
  };
  tenants?: Array<{
    tenant_slug: string;
    display_name: string;
    assigned_role: string;
    purpose?: string;
  }>;
  tutorial?: {
    mode: 'simulate' | 'apply' | 'skipped';
    summary?: string;
  };
  /**
   * Optional backend id (or alias) from the canonical catalog
   * (`knowledge/product/governance/reasoning-backend-policy.json`
   * `allowed_modes`). When set, it is persisted to `.env.local` as
   * `KYBERION_REASONING_BACKEND` — the non-interactive counterpart of the
   * wizard's reasoning-phase selection (LC-05).
   */
  reasoning_backend?: string;
}

function profileRoot(): string {
  return resolveActiveProfileRoot();
}

const ONBOARDING_PERSONAS = [
  'sovereign',
  'ecosystem_architect',
  'mission_owner',
  'worker',
  'analyst',
] as const;

function resolveInputPersona(input: ApplyInput): ApplyInput['identity']['persona'] {
  const requested = input.identity.persona?.trim().toLowerCase().replace(/\s+/g, '_');
  if (
    requested &&
    ONBOARDING_PERSONAS.includes(requested as (typeof ONBOARDING_PERSONAS)[number])
  ) {
    return requested as ApplyInput['identity']['persona'];
  }
  const persisted = readPersistedPersona();
  if (
    persisted &&
    ONBOARDING_PERSONAS.includes(persisted as (typeof ONBOARDING_PERSONAS)[number])
  ) {
    return persisted as ApplyInput['identity']['persona'];
  }
  return 'sovereign';
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

export function ensureDir(p: string) {
  if (!safeExistsSync(p)) safeMkdir(p, { recursive: true });
}

export async function readInput(file?: string): Promise<ApplyInput> {
  if (file) {
    if (!safeExistsSync(file)) {
      throw new Error(
        `identity file not found: ${file}. Copy ${ONBOARDING_IDENTITY_EXAMPLE} and retry, or use --dry-run first.`
      );
    }
    return loadJson<ApplyInput>(file);
  }
  // stdin fallback
  if (process.stdin.isTTY) {
    throw new Error(
      `No --identity given and stdin is a TTY. Pipe JSON or pass --identity <path>. Example: ${ONBOARDING_IDENTITY_EXAMPLE}. Use --dry-run first if you want to validate the payload.`
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ApplyInput;
}

export function validateInput(input: ApplyInput) {
  if (!input?.identity) {
    throw new Error(`identity block is required. See ${ONBOARDING_IDENTITY_EXAMPLE}.`);
  }
  const { name, language, interaction_style, primary_domain, vision, agent_id } = input.identity;
  if (!name || !language || !interaction_style || !primary_domain || !vision || !agent_id) {
    throw new Error(
      `identity requires {name, language, interaction_style, primary_domain, vision, agent_id}. See ${ONBOARDING_IDENTITY_EXAMPLE}.`
    );
  }
  if (!['Senior Partner', 'Concierge', 'Minimalist'].includes(interaction_style)) {
    throw new Error(
      `interaction_style must be one of Senior Partner | Concierge | Minimalist, got: ${interaction_style}`
    );
  }
  if (
    input.identity.persona !== undefined &&
    !ONBOARDING_PERSONAS.includes(
      input.identity.persona
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_') as (typeof ONBOARDING_PERSONAS)[number]
    )
  ) {
    throw new Error(
      `persona must be one of ${ONBOARDING_PERSONAS.join(' | ')}, got: ${input.identity.persona}`
    );
  }
  for (const tenant of input.tenants || []) {
    if (!isValidTenantSlug(tenant.tenant_slug)) {
      throw new Error(`Invalid tenant_slug: ${tenant.tenant_slug}`);
    }
  }
  if (input.reasoning_backend !== undefined) {
    if (normalizeReasoningBackendChoice(input.reasoning_backend) === null) {
      throw new Error(
        `Invalid reasoning_backend: ${input.reasoning_backend}. See knowledge/product/governance/reasoning-backend-policy.json (allowed_modes).`
      );
    }
  }
}

export async function writeJson(filePath: string, payload: unknown, lockName: string) {
  await withLock(lockName, async () => {
    withExecutionContext('sovereign_concierge', () => {
      ensureDir(path.dirname(filePath));
      safeWriteFile(filePath, JSON.stringify(payload, null, 2));
    });
  });
}

export async function writeText(filePath: string, content: string, lockName: string) {
  await withLock(lockName, async () => {
    withExecutionContext('sovereign_concierge', () => {
      ensureDir(path.dirname(filePath));
      safeWriteFile(filePath, content);
    });
  });
}

export async function applyIdentity(input: ApplyInput, now: string) {
  const profileDir = profileRoot();
  ensureDir(profileDir);
  ensureDir(onboardingRoot());

  const id = input.identity;
  const persona = resolveInputPersona(input);

  await writeJson(
    path.join(profileDir, 'my-identity.json'),
    {
      name: id.name,
      language: id.language,
      interaction_style: id.interaction_style,
      primary_domain: id.primary_domain,
      persona,
      created_at: now,
      status: 'active',
      version: '1.0.0',
    },
    'onboarding-my-identity'
  );

  await writeText(
    path.join(profileDir, 'my-vision.md'),
    `# Sovereign Vision\n\n${id.vision}\n`,
    'onboarding-my-vision'
  );

  await writeJson(
    path.join(profileDir, 'agent-identity.json'),
    {
      agent_id: id.agent_id,
      version: '1.0.0',
      role: 'Ecosystem Architect / Senior Partner',
      owner: id.name,
      trust_tier: 'sovereign',
      persona,
      created_at: now,
      description: `The primary autonomous entity of the Kyberion Ecosystem for ${id.name}.`,
    },
    'onboarding-agent-identity'
  );
}

export async function applyTenants(
  input: ApplyInput,
  now: string
): Promise<Array<Record<string, unknown>>> {
  const tenants = input.tenants || [];
  const tenantDir = path.join(profileRoot(), 'tenants');
  ensureDir(tenantDir);
  const entries: Array<Record<string, unknown>> = [];
  for (const t of tenants) {
    const profile = {
      tenant_slug: t.tenant_slug,
      tenant_id: t.tenant_slug,
      display_name: t.display_name,
      status: 'active' as const,
      assigned_role: t.assigned_role,
      purpose: t.purpose,
      created_at: now,
      // Cross-tenant/public learning is an explicit brokered promotion, never
      // an onboarding default. Strict isolation must remain meaningful.
      isolation_policy: { strict_isolation: true, allow_cross_distillation: false },
      metadata: { onboarding_source: 'pnpm onboard:apply' },
    };
    await writeJson(
      path.join(tenantDir, `${t.tenant_slug}.json`),
      profile,
      `onboarding-tenant-${t.tenant_slug}`
    );
    entries.push({
      tenant_slug: t.tenant_slug,
      tenant_id: t.tenant_slug,
      display_name: t.display_name,
      status: 'active',
      assigned_role: t.assigned_role,
      purpose: t.purpose,
      created_at: now,
    });
  }
  return entries;
}

export async function applyTutorial(input: ApplyInput, now: string) {
  const mode = input.tutorial?.mode || 'simulate';
  const flowPolicy = resolveOnboardingFlowPolicy();
  const onboardingLocale = resolveOperatorLocale();
  const summary =
    input.tutorial?.summary ||
    resolveOnboardingText(flowPolicy.tutorial_default_summary, onboardingLocale);
  const planPath = path.join(onboardingRoot(), 'tutorial-plan.md');
  await writeText(
    planPath,
    [
      `# ${resolveOnboardingText(flowPolicy.tutorial_plan_title, onboardingLocale)}`,
      '',
      `- Mode: ${mode}`,
      `- Summary: ${summary}`,
      '',
      `## ${resolveOnboardingText(flowPolicy.tutorial_next_step_title, onboardingLocale)}`,
      mode === 'apply'
        ? '- Review the plan and create a mission manually if the setup is ready.'
        : '- Run the tutorial as a dry-run first, then decide whether to promote it to a mission.',
      '',
    ].join('\n'),
    'onboarding-tutorial-plan'
  );
  return { mode, summary, plan_path: planPath };
}

export function buildState(
  input: ApplyInput,
  now: string,
  tenantEntries: Array<Record<string, unknown>>,
  tutorial: { mode: string; summary: string; plan_path: string },
  reasoning: OnboardingReasoningState
) {
  const persona = resolveInputPersona(input);
  return {
    version: '1.0.0' as const,
    status: 'complete' as const,
    current_phase: 'summary' as const,
    completed_phases: ['identity', 'reasoning', 'services', 'tenants', 'tutorial', 'summary'],
    created_at: now,
    updated_at: now,
    identity: { ...input.identity, persona },
    reasoning,
    services: { candidates: [] },
    tenants: { entries: tenantEntries },
    tutorial,
  };
}

export function buildSummary(
  input: ApplyInput,
  tenantEntries: Array<Record<string, unknown>>,
  tutorial: { mode: string; summary: string },
  reasoning?: OnboardingReasoningState
) {
  const id = input.identity;
  const persona = resolveInputPersona(input);
  const summaryPolicy = resolveOnboardingSummaryPolicy();
  const lines = [
    `# ${summaryPolicy.title}`,
    '',
    `## ${summaryPolicy.sections.identity}`,
    `- Name: ${id.name}`,
    `- Language: ${id.language}`,
    `- Style: ${id.interaction_style}`,
    `- Domain: ${id.primary_domain}`,
    `- Vision: ${id.vision}`,
    `- Agent ID: ${id.agent_id}`,
    `- Persona: ${persona}`,
    '',
    '## Reasoning Backend',
    ...formatReasoningSummary(reasoning),
    '',
    `## ${summaryPolicy.sections.services}`,
    `- ${summaryPolicy.empty_states.services}`,
    '',
    `## ${summaryPolicy.sections.tenants}`,
    ...(tenantEntries.length > 0
      ? tenantEntries.map((t) => `- ${t.tenant_slug}: ${t.display_name} [${t.assigned_role}]`)
      : [`- ${summaryPolicy.empty_states.tenants}`]),
    '',
    `## ${summaryPolicy.sections.tutorial}`,
    `- Mode: ${tutorial.mode}`,
    `- Summary: ${tutorial.summary}`,
    '',
    `## ${summaryPolicy.sections.next_steps}`,
    '- Run `pnpm vital --format=json` to verify the live ecosystem health.',
    '- Open Chronos at http://127.0.0.1:3000 — your Identity Badge should appear in the header.',
    '',
    '## Runbook Skill',
    `- Generated: ${path.join(onboardingRoot(), 'skills', 'kyberion-onboarding-runbook', 'SKILL.md')}`,
    '',
  ];
  return lines.join('\n');
}

export function buildApplySummary(
  input: ApplyInput,
  tenantEntries: Array<Record<string, unknown>>,
  tutorial: { mode: string; summary: string },
  reasoning: OnboardingReasoningState,
  paths: { statePath: string; summaryPath: string }
): string {
  const lines = [
    'Onboarding applied successfully.',
    `Identity: ${input.identity.name} (${input.identity.agent_id})`,
    `Persona: ${resolveInputPersona(input)}`,
    `Tenants: ${tenantEntries.length}`,
    `Tutorial: ${tutorial.mode}`,
    `Reasoning: ${reasoning.mode}`,
    `State: ${paths.statePath}`,
    `Summary: ${paths.summaryPath}`,
    '',
    'Next steps:',
    '1. Run `pnpm vital` to verify the live ecosystem health.',
    '2. Open Chronos to confirm the identity badge and tenant context.',
    '3. Re-run `pnpm onboard:apply --json` if you need machine-readable output.',
  ];
  return lines.join('\n');
}

export async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('identity', {
      type: 'string',
      describe: 'Path to identity JSON (or pipe JSON via stdin)',
    })
    .option('dry-run', { type: 'boolean', default: false })
    .option('json', {
      type: 'boolean',
      default: false,
      describe: 'Emit machine-readable JSON output',
    })
    .strict()
    .parse();

  process.env.MISSION_ROLE = 'sovereign_concierge';
  process.env.KYBERION_PERSONA = 'sovereign';

  const input = await readInput(argv.identity as string | undefined);
  validateInput(input);

  if (argv['dry-run']) {
    console.log(JSON.stringify({ status: 'validated', identity: input.identity }, null, 2));
    return;
  }

  const ajv = createAjv();
  addFormats(ajv);
  const validateState = compileSchemaFromPath(
    ajv,
    pathResolver.rootResolve('knowledge/product/schemas/onboarding-state.schema.json')
  );

  const now = new Date().toISOString();
  const persona = resolveInputPersona(input);
  const personaEnvPath = persistPersona(persona);
  process.env.KYBERION_PERSONA = persona;
  console.log(`Persisted KYBERION_PERSONA=${persona} to ${personaEnvPath}`);
  await applyIdentity(input, now);
  const tenantEntries = await applyTenants(input, now);
  const tutorial = await applyTutorial(input, now);
  // LC-05: an explicitly supplied backend is persisted before evaluation so
  // the recorded choice (not auto-discovery) drives the reasoning check and
  // every later run. Non-interactive input is explicit consent to overwrite.
  if (input.reasoning_backend !== undefined) {
    const backend = normalizeReasoningBackendChoice(input.reasoning_backend);
    if (backend) {
      const envLocal = persistReasoningBackend(backend);
      process.env.KYBERION_REASONING_BACKEND = backend;
      console.log(`Persisted KYBERION_REASONING_BACKEND=${backend} to ${envLocal}`);
    }
  }
  const reasoning = await evaluateReasoningBackend(new Date(now));
  const runbookSkill = generateOnboardingRunbookSkill({
    profileRoot: profileRoot(),
    identityName: input.identity.name,
    agentId: input.identity.agent_id,
    generatedAt: now,
  });
  const state = buildState(input, now, tenantEntries, tutorial, reasoning);
  if (!validateState(state)) {
    throw new Error(`onboarding-state schema invalid: ${JSON.stringify(validateState.errors)}`);
  }
  await writeJson(statePath(), state, 'onboarding-state');
  await writeText(
    summaryPath(),
    buildSummary(input, tenantEntries, tutorial, reasoning),
    'onboarding-summary'
  );

  const result = {
    status: 'complete',
    identity_name: input.identity.name,
    agent_id: input.identity.agent_id,
    tenants: tenantEntries.length,
    reasoning,
    state_path: statePath(),
    summary_path: summaryPath(),
    runbook_skill_path: runbookSkill.skillPath,
  };
  if (argv.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    buildApplySummary(input, tenantEntries, tutorial, reasoning, {
      statePath: statePath(),
      summaryPath: summaryPath(),
    })
  );
}

const isMainModule = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');

if (isMainModule) {
  main().catch((err) => {
    console.error('onboarding_apply failed:', err.message || err);
    process.exit(1);
  });
}
