import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv';
import AjvFormats from 'ajv-formats';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  compileSchemaFromPath,
  customerResolver,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  withExecutionContext,
  withLock,
} from '@agent/core';

const AjvCtor: any = (AjvModule as any).default || (AjvModule as any);
const addFormats: any = (AjvFormats as any).default || AjvFormats;

interface ApplyInput {
  identity: {
    name: string;
    language: string;
    interaction_style: 'Senior Partner' | 'Concierge' | 'Minimalist';
    primary_domain: string;
    vision: string;
    agent_id: string;
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
}

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

export function ensureDir(p: string) {
  if (!safeExistsSync(p)) safeMkdir(p, { recursive: true });
}

export async function readInput(file?: string): Promise<ApplyInput> {
  if (file) {
    if (!safeExistsSync(file)) throw new Error(`identity file not found: ${file}`);
    return JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string) as ApplyInput;
  }
  // stdin fallback
  if (process.stdin.isTTY) {
    throw new Error('No --identity given and stdin is a TTY. Pipe JSON or pass --identity <path>.');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ApplyInput;
}

export function validateInput(input: ApplyInput) {
  if (!input?.identity) throw new Error('identity block is required');
  const { name, language, interaction_style, primary_domain, vision, agent_id } = input.identity;
  if (!name || !language || !interaction_style || !primary_domain || !vision || !agent_id) {
    throw new Error('identity requires {name, language, interaction_style, primary_domain, vision, agent_id}');
  }
  if (!['Senior Partner', 'Concierge', 'Minimalist'].includes(interaction_style)) {
    throw new Error(`interaction_style must be one of Senior Partner | Concierge | Minimalist, got: ${interaction_style}`);
  }
  for (const tenant of input.tenants || []) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(tenant.tenant_slug)) {
      throw new Error(`Invalid tenant_slug: ${tenant.tenant_slug}`);
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

  await writeJson(path.join(profileDir, 'my-identity.json'), {
    name: id.name,
    language: id.language,
    interaction_style: id.interaction_style,
    primary_domain: id.primary_domain,
    created_at: now,
    status: 'active',
    version: '1.0.0',
  }, 'onboarding-my-identity');

  await writeText(path.join(profileDir, 'my-vision.md'), `# Sovereign Vision\n\n${id.vision}\n`, 'onboarding-my-vision');

  await writeJson(path.join(profileDir, 'agent-identity.json'), {
    agent_id: id.agent_id,
    version: '1.0.0',
    role: 'Ecosystem Architect / Senior Partner',
    owner: id.name,
    trust_tier: 'sovereign',
    created_at: now,
    description: `The primary autonomous entity of the Kyberion Ecosystem for ${id.name}.`,
  }, 'onboarding-agent-identity');
}

export async function applyTenants(input: ApplyInput, now: string): Promise<Array<Record<string, unknown>>> {
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
      isolation_policy: { strict_isolation: true, allow_cross_distillation: true },
      metadata: { onboarding_source: 'pnpm onboard:apply' },
    };
    await writeJson(path.join(tenantDir, `${t.tenant_slug}.json`), profile, `onboarding-tenant-${t.tenant_slug}`);
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
  const summary = input.tutorial?.summary || 'Demonstrate the initial Kyberion setup with a safe dry-run.';
  const planPath = path.join(onboardingRoot(), 'tutorial-plan.md');
  await writeText(planPath, [
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
  ].join('\n'), 'onboarding-tutorial-plan');
  return { mode, summary, plan_path: planPath };
}

export function buildState(input: ApplyInput, now: string, tenantEntries: Array<Record<string, unknown>>, tutorial: { mode: string; summary: string; plan_path: string }) {
  return {
    version: '1.0.0' as const,
    status: 'complete' as const,
    current_phase: 'summary' as const,
    completed_phases: ['identity', 'services', 'tenants', 'tutorial', 'summary'],
    created_at: now,
    updated_at: now,
    identity: input.identity,
    services: { candidates: [] },
    tenants: { entries: tenantEntries },
    tutorial,
  };
}

export function buildSummary(input: ApplyInput, tenantEntries: Array<Record<string, unknown>>, tutorial: { mode: string; summary: string }) {
  const id = input.identity;
  const lines = [
    '# Kyberion Onboarding Summary',
    '',
    '## Identity',
    `- Name: ${id.name}`,
    `- Language: ${id.language}`,
    `- Style: ${id.interaction_style}`,
    `- Domain: ${id.primary_domain}`,
    `- Vision: ${id.vision}`,
    `- Agent ID: ${id.agent_id}`,
    '',
    '## Services',
    '- None captured yet',
    '',
    '## Tenants',
    ...(tenantEntries.length > 0
      ? tenantEntries.map((t) => `- ${t.tenant_slug}: ${t.display_name} [${t.assigned_role}]`)
      : ['- None registered yet']),
    '',
    '## Tutorial',
    `- Mode: ${tutorial.mode}`,
    `- Summary: ${tutorial.summary}`,
    '',
    '## Next Steps',
    '- Run `pnpm vital --format=json` to verify the live ecosystem health.',
    '- Open Chronos at http://127.0.0.1:3000 — your Identity Badge should appear in the header.',
    '',
  ];
  return lines.join('\n');
}

export async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('identity', { type: 'string', describe: 'Path to identity JSON (or pipe JSON via stdin)' })
    .option('dry-run', { type: 'boolean', default: false })
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

  const ajv = new AjvCtor({ allErrors: true });
  addFormats(ajv);
  const validateState = compileSchemaFromPath(
    ajv,
    pathResolver.rootResolve('knowledge/public/schemas/onboarding-state.schema.json'),
  );

  const now = new Date().toISOString();
  await applyIdentity(input, now);
  const tenantEntries = await applyTenants(input, now);
  const tutorial = await applyTutorial(input, now);
  const state = buildState(input, now, tenantEntries, tutorial);
  if (!validateState(state)) {
    throw new Error(`onboarding-state schema invalid: ${JSON.stringify(validateState.errors)}`);
  }
  await writeJson(statePath(), state, 'onboarding-state');
  await writeText(summaryPath(), buildSummary(input, tenantEntries, tutorial), 'onboarding-summary');

  console.log(JSON.stringify({
    status: 'complete',
    identity_name: input.identity.name,
    agent_id: input.identity.agent_id,
    tenants: tenantEntries.length,
    state_path: statePath(),
    summary_path: summaryPath(),
  }, null, 2));
}

const isMainModule = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');

if (isMainModule) {
  main().catch((err) => {
    console.error('onboarding_apply failed:', err.message || err);
    process.exit(1);
  });
}
