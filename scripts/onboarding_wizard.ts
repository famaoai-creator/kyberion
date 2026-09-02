import * as path from 'node:path';
import * as readline from 'node:readline';
import chalk from 'chalk';
import * as customerResolver from '@agent/core/customer-resolver';
import { ensureDefaultTenantProfile } from '@agent/core/tenant-registry';
import { listServiceOnboardingCatalogEntries } from '@agent/core/service-onboarding-catalog';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import {
  resolveOnboardingFlowPolicy,
  resolveOnboardingText,
  type LocalizedOnboardingText,
} from '@agent/core/onboarding-flow-policy';
import { resolveOnboardingSummaryPolicy } from '@agent/core/onboarding-summary-policy';
import { resolveVocabularyLocale } from '@agent/core/ux-vocabulary';
import { isServiceConnectionReady } from '@agent/core/service-connection-readiness';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import type { SupportedLocale } from '@agent/core/locale';
import { safeExistsSync, safeLstat, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { withLock } from '@agent/core/src/lock-utils';
import {
  compileSchema,
  getRegisteredEnvText,
  nowIso,
  readJson,
  setRegisteredEnv,
} from '@agent/core/foundation';
import { spawnManagedProcess, stopManagedProcess } from '@agent/core/managed-process';
import { withSensitivePathMediation } from '@agent/core/secure-io';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { createCustomer } from './customer_create.js';
import { switchCustomer } from './customer_switch.js';
import { isExpressOnboarding, shouldRefuseNonInteractiveOnboarding } from './onboarding_mode.js';
import {
  evaluateReasoningBackend,
  formatReasoningSummary,
  markReasoningStubAcknowledged,
  type OnboardingReasoningState,
} from './onboarding_reasoning.js';
import {
  generateOnboardingRunbookSkill,
  onboardingRunbookSkillPath,
} from './onboarding_runbook_skill.js';
import {
  formatReasoningBackendMenu,
  listReasoningBackendChoices,
  persistReasoningBackend,
  readPersistedReasoningBackend,
  persistPersona,
  readPersistedPersona,
  resolveReasoningBackendMenuSelection,
} from './reasoning_backend_selection.js';

const onboardingStateValidate = compileSchema(
  pathResolver.rootResolve('knowledge/product/schemas/onboarding-state.schema.json')
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Wizard prompts follow the operator's selected language immediately: the
// locale seeds from the saved identity (default Japanese) and is re-resolved
// as soon as the language question is answered (UX-03).
//
// I18N-07 finding: this was hardcoded to `'en' | 'ja'`, which broke `tsc`
// the moment `SupportedLocale` grew a third member (`resolveVocabularyLocale`
// already returns the full `SupportedLocale`) — widened to match rather than
// special-casing the new locale. `t()`/`pt()` below already fall through to
// English for anything that isn't `'ja'`, so behavior is unchanged.
let wizardLocale: SupportedLocale = 'ja';

function setWizardLanguage(language: string): void {
  wizardLocale = resolveVocabularyLocale(language);
}

function t(en: string, ja: string): string {
  return wizardLocale === 'ja' ? ja : en;
}

function pt(value: LocalizedOnboardingText): string {
  return resolveOnboardingText(value, wizardLocale);
}

// I18N-02/03: re-configuration menu strings live in the vocabulary catalog
// (`onboarding` namespace) rather than as hardcoded literals; render them
// through the typed catalog `t()` pinned to the wizard's live locale so the
// menu follows the language selected during onboarding.
function mt(key: VocabularyKey): string {
  return catalogT(key, undefined, wizardLocale);
}

// Menu actions launch `node dist/scripts/...` children through the
// supervised managed-process wrapper (never direct child_process — see
// kyberion-development-practices §1). stdio is inherited so the child owns
// the terminal exactly like the wizard itself; the promise rejects on a
// non-zero exit so callers can surface a catalog-rendered error message.
async function runManagedMenuTask(taskId: string, args: string[]): Promise<void> {
  const resourceId = `onboarding-menu:${taskId}:${Date.now().toString(36)}`;
  const { child } = spawnManagedProcess({
    resourceId,
    kind: 'service',
    ownerId: 'onboarding-wizard',
    ownerType: 'script',
    command: process.execPath,
    args,
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      env: process.env,
      stdio: 'inherit',
    },
    metadata: { source: 'onboarding-wizard-menu', taskId },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              signal ? `terminated by signal ${signal}` : `exited with code ${code ?? 'unknown'}`
            )
          );
        }
      });
    });
  } finally {
    stopManagedProcess(resourceId, child);
  }
}

function formatMenuTaskError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type OnboardingPhase = 'identity' | 'reasoning' | 'services' | 'tenants' | 'tutorial' | 'summary';
type OnboardingStatus = 'draft' | 'complete';
type ServiceStatus = 'pending' | 'saved' | 'ready' | 'blocked' | 'skipped';

interface IdentityDraft {
  name: string;
  language: string;
  interaction_style: 'Senior Partner' | 'Concierge' | 'Minimalist';
  primary_domain: string;
  vision: string;
  agent_id: string;
  persona: 'sovereign' | 'ecosystem_architect' | 'mission_owner' | 'worker' | 'analyst';
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
  reasoning?: OnboardingReasoningState;
  services?: { candidates: ServiceCandidateDraft[] };
  tenants?: { entries: TenantDraft[] };
  tutorial?: TutorialDraft;
}

const PHASES: OnboardingPhase[] = [
  'identity',
  'reasoning',
  'services',
  'tenants',
  'tutorial',
  'summary',
];
function profileRoot(): string {
  return resolveActiveProfileRoot();
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
const expressMode = isExpressOnboarding();

const ask = async (question: string, defaultValue = ''): Promise<string> => {
  if (!interactive || expressMode) {
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
  if (isValidTenantSlug(trimmed)) return trimmed;
  throw new Error(`Invalid tenant slug: ${value}`);
};

const isAffirmative = (value: string): boolean =>
  /^(y|yes|true|1|ok|sure|please)$/i.test(value.trim());

const ensureArtifactDir = (filePath: string): void => {
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
};

function assertOnboardingStateSchema(state: OnboardingState): void {
  if (onboardingStateValidate(state)) return;
  const errors = Array.isArray(onboardingStateValidate.errors)
    ? onboardingStateValidate.errors
        .map((entry: any) => `${entry.instancePath || '/'} ${entry.message || 'invalid'}`)
        .join('; ')
    : 'unknown schema error';
  throw new Error(`[ONBOARDING_STATE_SCHEMA] Invalid onboarding state: ${errors}`);
}

async function writeJsonArtifact(
  filePath: string,
  payload: unknown,
  lockName: string
): Promise<void> {
  await withLock(lockName, async () => {
    withExecutionContext('sovereign_concierge', () => {
      withSensitivePathMediation(() => {
        ensureArtifactDir(filePath);
        safeWriteFile(filePath, JSON.stringify(payload, null, 2));
      });
    });
  });
}

async function writeTextArtifact(
  filePath: string,
  content: string,
  lockName: string
): Promise<void> {
  await withLock(lockName, async () => {
    withExecutionContext('sovereign_concierge', () => {
      withSensitivePathMediation(() => {
        ensureArtifactDir(filePath);
        safeWriteFile(filePath, content);
      });
    });
  });
}

function loadState(): OnboardingState | null {
  const filePath = statePath();
  if (!safeExistsSync(filePath)) return null;
  if (!safeLstat(filePath).isFile()) return null;
  try {
    const parsed = readJson<OnboardingState>(filePath);
    if (parsed.identity && !parsed.identity.persona) {
      parsed.identity.persona = 'sovereign';
    }
    return parsed;
  } catch {
    return null;
  }
}

async function saveState(state: OnboardingState): Promise<void> {
  assertOnboardingStateSchema(state);
  await writeJsonArtifact(statePath(), state, 'onboarding-state');
}

function createInitialState(): OnboardingState {
  const now = nowIso();
  const state: OnboardingState = {
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
  // A services-only run still persists onboarding-state.json. Seed the
  // schema-required identity so that connection setup works before the
  // interactive identity phase has been completed.
  state.identity = buildIdentityFromState(state);
  return state;
}

function buildIdentityFromState(state: OnboardingState): IdentityDraft {
  const existing = state.identity;
  const persistedPersona = readPersistedPersona();
  const validPersistedPersona =
    persistedPersona &&
    ['sovereign', 'ecosystem_architect', 'mission_owner', 'worker', 'analyst'].includes(
      persistedPersona
    )
      ? (persistedPersona as IdentityDraft['persona'])
      : undefined;
  return {
    name: existing?.name || 'Sovereign',
    language: existing?.language || 'Japanese',
    interaction_style: existing?.interaction_style || 'Concierge',
    primary_domain: existing?.primary_domain || 'General',
    vision: existing?.vision || 'Build a high-fidelity Kyberion environment.',
    agent_id: existing?.agent_id || 'KYBERION-PRIME',
    persona: existing?.persona || validPersistedPersona || 'sovereign',
  };
}

function connectionIsReady(serviceId: string, payload: Record<string, unknown>): boolean {
  return isServiceConnectionReady(serviceId, payload);
}

function buildSummaryMarkdown(state: OnboardingState): string {
  const identity = state.identity;
  const services = state.services?.candidates || [];
  const tenants = state.tenants?.entries || [];
  const tutorial = state.tutorial;
  const summaryPolicy = resolveOnboardingSummaryPolicy();

  return [
    `# ${summaryPolicy.title}`,
    '',
    `## ${summaryPolicy.sections.identity}`,
    `- Name: ${identity?.name || 'n/a'}`,
    `- Language: ${identity?.language || 'n/a'}`,
    `- Style: ${identity?.interaction_style || 'n/a'}`,
    `- Domain: ${identity?.primary_domain || 'n/a'}`,
    `- Vision: ${identity?.vision || 'n/a'}`,
    `- Agent ID: ${identity?.agent_id || 'n/a'}`,
    `- Persona: ${identity?.persona || 'n/a'}`,
    '',
    '## Reasoning Backend',
    ...formatReasoningSummary(state.reasoning),
    '',
    `## ${summaryPolicy.sections.services}`,
    ...(services.length > 0
      ? services.map(
          (entry) =>
            `- ${entry.service_id}: ${entry.status}${entry.connection_kind ? ` (${entry.connection_kind})` : ''}`
        )
      : [`- ${summaryPolicy.empty_states.services}`]),
    '',
    `## ${summaryPolicy.sections.tenants}`,
    ...(tenants.length > 0
      ? tenants.map(
          (tenant) => `- ${tenant.tenant_slug}: ${tenant.display_name} [${tenant.assigned_role}]`
        )
      : [`- ${summaryPolicy.empty_states.tenants}`]),
    '',
    `## ${summaryPolicy.sections.tutorial}`,
    `- Mode: ${tutorial?.mode || 'skipped'}`,
    `- Summary: ${tutorial?.summary || 'n/a'}`,
    '',
    `## ${summaryPolicy.sections.next_steps}`,
    '- Review candidate service connections before using them in missions.',
    '- Register additional tenants one at a time.',
    '- Convert the tutorial into an explicit mission only after confirming the setup.',
    '',
    '## Runbook Skill',
    `- Generated: ${onboardingRunbookSkillPath(profileRoot())}`,
    '',
  ].join('\n');
}

async function runIdentityPhase(state: OnboardingState): Promise<void> {
  const flowPolicy = resolveOnboardingFlowPolicy();
  console.log(`\n🧬 Phase 1 — ${pt(flowPolicy.phase_titles.identity)}\n`);
  const identity = buildIdentityFromState(state);
  setWizardLanguage(identity.language);

  identity.name = await ask(
    t(`How should I call you? [${identity.name}]: `, `お名前(呼び方)は? [${identity.name}]: `),
    identity.name
  );
  identity.language = await ask(
    t(`Preferred language? [${identity.language}]: `, `希望する言語は? [${identity.language}]: `),
    identity.language
  );
  setWizardLanguage(identity.language);
  const styleInput = await ask(
    t(
      `Interaction style (Senior Partner / Concierge / Minimalist) [${identity.interaction_style}]: `,
      `対話スタイル(Senior Partner / Concierge / Minimalist)[${identity.interaction_style}]: `
    ),
    identity.interaction_style
  );
  identity.interaction_style = normalizeInteractionStyle(styleInput || identity.interaction_style);
  identity.primary_domain = await ask(
    t(
      `Primary domain? [${identity.primary_domain}]: `,
      `主な活動ドメインは? [${identity.primary_domain}]: `
    ),
    identity.primary_domain
  );
  identity.vision = await ask(
    t(
      `Core vision for this environment? [${identity.vision}]: `,
      `この環境のコアビジョンは? [${identity.vision}]: `
    ),
    identity.vision
  );
  identity.agent_id =
    (
      await ask(
        t(`Agent ID? [${identity.agent_id}]: `, `エージェント ID は? [${identity.agent_id}]: `),
        identity.agent_id
      )
    )
      .trim()
      .toUpperCase() || 'KYBERION-PRIME';

  const personaInput = (
    await ask(
      t(
        `Default persona for later operations? [${identity.persona}]: `,
        `後続操作で使う既定 persona は? [${identity.persona}]: `
      ),
      identity.persona
    )
  )
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (
    ['sovereign', 'ecosystem_architect', 'mission_owner', 'worker', 'analyst'].includes(
      personaInput
    )
  ) {
    identity.persona = personaInput as IdentityDraft['persona'];
  }
  const personaEnvPath = persistPersona(identity.persona);
  console.log(
    t(
      `Persisted default persona ${identity.persona} to ${personaEnvPath}`,
      `既定 persona ${identity.persona} を ${personaEnvPath} に永続化しました`
    )
  );

  await writeJsonArtifact(
    identityPath(),
    {
      name: identity.name,
      language: identity.language,
      interaction_style: identity.interaction_style,
      primary_domain: identity.primary_domain,
      persona: identity.persona,
      created_at: state.created_at,
      status: 'active',
      version: '1.0.0',
    },
    'onboarding-my-identity'
  );

  await writeTextArtifact(
    visionPath(),
    `# Sovereign Vision\n\n${identity.vision}\n`,
    'onboarding-my-vision'
  );

  await writeJsonArtifact(
    agentIdentityPath(),
    {
      agent_id: identity.agent_id,
      version: '1.0.0',
      role: 'Ecosystem Architect / Senior Partner',
      owner: identity.name,
      trust_tier: 'sovereign',
      persona: identity.persona,
      created_at: state.created_at,
      description: `The primary autonomous entity of the Kyberion Ecosystem for ${identity.name}.`,
    },
    'onboarding-agent-identity'
  );

  state.identity = identity;
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'identity']));
  // LC-05c: the next phase is 'reasoning' — jumping straight to 'services'
  // made a resumed wizard skip backend selection entirely.
  state.current_phase = 'reasoning';
  state.updated_at = nowIso();
  await saveState(state);
}

async function runReasoningPhase(state: OnboardingState): Promise<void> {
  console.log(t('\nReasoning Backend\n', '\n推論バックエンド\n'));
  let reasoning = await evaluateReasoningBackend();
  if (reasoning.available) {
    console.log(
      chalk.green(t('Real reasoning backend detected.', '実働する推論バックエンドを検出しました。'))
    );
  } else if (reasoning.mode === 'stub_explicit') {
    console.log(
      chalk.yellow(
        t(
          'KYBERION_REASONING_BACKEND=stub is explicitly selected.',
          'KYBERION_REASONING_BACKEND=stub が明示的に選択されています。'
        )
      )
    );
    console.log(
      chalk.yellow(
        t(
          'Real work will use deterministic placeholder responses until reconfigured.',
          '再設定するまで、実作業は決定論的なプレースホルダ応答になります。'
        )
      )
    );
  } else {
    console.log(
      chalk.red(
        t(
          'No real reasoning backend was detected.',
          '実働する推論バックエンドが見つかりませんでした。'
        )
      )
    );
    console.log(
      reasoning.reason ??
        t(
          'Run `pnpm reasoning:setup` to configure one.',
          '`pnpm reasoning:setup` を実行して設定してください。'
        )
    );
    console.log(
      t(
        '\nRun `pnpm reasoning:setup` to configure Codex/Gemini/AGY CLI, Anthropic API, OpenRouter, or a local backend.',
        '\n`pnpm reasoning:setup` で Codex/Gemini/AGY CLI・Anthropic API・OpenRouter・ローカルバックエンドを設定できます。'
      )
    );
    if (interactive && !expressMode) {
      const continueWithStub = isAffirmative(
        await ask(
          t(
            'Continue onboarding in stub-only mode? Real work will not be usable. (y/N): ',
            'スタブのみのモードでオンボーディングを続けますか?実作業は使用できません。(y/N): '
          ),
          'n'
        )
      );
      if (!continueWithStub) {
        console.log(
          t(
            'Onboarding paused. Configure a reasoning backend, then re-run `pnpm onboard`.',
            'オンボーディングを中断しました。推論バックエンドを設定してから `pnpm onboard` を再実行してください。'
          )
        );
        rl.close();
        throw new ScriptExitError(2);
      }
    }
    reasoning = markReasoningStubAcknowledged(reasoning);
  }

  // LC-05a: detection alone is not a decision — offer an explicit backend
  // choice (catalog = reasoning-backend policy) and persist it to .env.local
  // so later runs use the recorded selection instead of auto-discovery.
  if (interactive && !expressMode) {
    const choices = listReasoningBackendChoices();
    const persisted =
      getRegisteredEnvText('KYBERION_REASONING_BACKEND')?.trim() || readPersistedReasoningBackend();
    console.log('');
    console.log(
      t(
        'Select the reasoning backend to persist as KYBERION_REASONING_BACKEND:',
        '永続化する推論バックエンド(KYBERION_REASONING_BACKEND)を選択してください:'
      )
    );
    for (const line of formatReasoningBackendMenu(choices)) {
      console.log(`  ${line}`);
    }
    if (persisted) {
      console.log(t(`Currently set: ${persisted}`, `現在の設定: ${persisted}`));
    }
    const answer = await ask(
      t(
        `Backend [1-${choices.length}, name, or enter to skip]: `,
        `バックエンド [1-${choices.length}・名前・Enter でスキップ]: `
      ),
      ''
    );
    const selection = resolveReasoningBackendMenuSelection(answer, choices);
    if (selection) {
      let proceed = true;
      if (persisted && persisted !== selection) {
        proceed = isAffirmative(
          await ask(
            t(
              `Overwrite KYBERION_REASONING_BACKEND (${persisted} -> ${selection})? (y/N): `,
              `KYBERION_REASONING_BACKEND を上書きしますか (${persisted} -> ${selection})? (y/N): `
            ),
            'n'
          )
        );
      }
      if (proceed) {
        const envLocal = persistReasoningBackend(selection);
        setRegisteredEnv('KYBERION_REASONING_BACKEND', selection);
        reasoning = { ...reasoning, backend_hint: selection };
        console.log(
          t(
            `Persisted KYBERION_REASONING_BACKEND=${selection} to ${envLocal}`,
            `KYBERION_REASONING_BACKEND=${selection} を ${envLocal} に永続化しました`
          )
        );
      }
    }
  }

  state.reasoning = reasoning;
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'reasoning']));
  state.current_phase = 'services';
  state.updated_at = nowIso();
  await saveState(state);
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

async function promptVoiceConnection(): Promise<Record<string, unknown> | null> {
  const voicePythonBin = await ask('Voice Python binary [optional]: ');
  const voiceName = await ask('Voice name [optional]: ');
  const notes = await ask('Voice notes [optional]: ');
  if (!voicePythonBin && !voiceName && !notes) return null;
  return {
    voice_python_bin: voicePythonBin || undefined,
    voice_name: voiceName || undefined,
    notes: notes || undefined,
    source: 'onboarding',
  };
}

async function promptMeetingConnection(): Promise<Record<string, unknown> | null> {
  const meetingPythonBin = await ask('Meeting Python binary [optional]: ');
  const notes = await ask('Meeting notes [optional]: ');
  if (!meetingPythonBin && !notes) return null;
  return {
    meeting_python_bin: meetingPythonBin || undefined,
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

async function runServicesPhase(
  state: OnboardingState,
  selectedServiceIds?: string[]
): Promise<void> {
  const flowPolicy = resolveOnboardingFlowPolicy();
  console.log(`\n🔌 Phase 2 — ${pt(flowPolicy.phase_titles.services)}\n`);
  const wantsServiceSetup = selectedServiceIds?.length
    ? true
    : isAffirmative(
        await ask(
          t(
            'Capture service connection candidates now? (y/N): ',
            'サービス接続候補を今すぐ登録しますか? (y/N): '
          ),
          'n'
        )
      );
  const candidates: ServiceCandidateDraft[] = [];
  const connDir = connectionDir();
  withSensitivePathMediation(() => {
    if (!safeExistsSync(connDir)) safeMkdir(connDir, { recursive: true });
  });
  const onboardingServices = listServiceOnboardingCatalogEntries().filter(
    (service) => !selectedServiceIds || selectedServiceIds.includes(service.service_id)
  );
  if (selectedServiceIds?.length && onboardingServices.length !== selectedServiceIds.length) {
    const known = new Set(onboardingServices.map((service) => service.service_id));
    const unknown = selectedServiceIds.filter((serviceId) => !known.has(serviceId));
    throw new Error(`Unknown onboarding service: ${unknown.join(', ')}`);
  }

  if (wantsServiceSetup) {
    for (const service of onboardingServices) {
      const serviceId = service.service_id;
      const wantsThisService = isAffirmative(
        await ask(`Add ${serviceId} connection now? (y/N): `, 'n')
      );
      if (!wantsThisService) {
        candidates.push({
          service_id: serviceId,
          status: 'skipped',
          connection_kind: 'none',
          captured_at: nowIso(),
        });
        continue;
      }

      let payload: Record<string, unknown> | null = null;
      if (service.prompt_kind === 'comfyui') {
        payload = await promptComfyuiConnection();
      } else if (service.prompt_kind === 'whisper') {
        payload = await promptWhisperConnection();
      } else if (serviceId === 'voice') {
        payload = await promptVoiceConnection();
      } else if (serviceId === 'meeting') {
        payload = await promptMeetingConnection();
      } else {
        payload = await promptGenericConnection(serviceId);
      }

      const capturedAt = nowIso();
      const ready = payload ? connectionIsReady(serviceId, payload) : false;
      const candidate: ServiceCandidateDraft = {
        service_id: serviceId,
        status: payload ? (ready ? 'ready' : 'blocked') : 'pending',
        connection_kind: payload?.base_url
          ? 'base_url'
          : payload?.output_dir
            ? 'output_dir'
            : payload?.cli_path
              ? 'cli_path'
              : payload
                ? 'custom'
                : 'none',
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
            status: ready ? 'ready' : 'blocked',
            captured_at: capturedAt,
            ...payload,
          },
          `onboarding-connection-${serviceId}`
        );
      }
    }
  }

  const previous = (state.services?.candidates || []).filter(
    (candidate) => !candidates.some((next) => next.service_id === candidate.service_id)
  );
  state.services = { candidates: [...previous, ...candidates] };
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'services']));
  state.current_phase = 'tenants';
  state.updated_at = nowIso();
  await saveState(state);
}

async function runTenantsPhase(state: OnboardingState): Promise<void> {
  const flowPolicy = resolveOnboardingFlowPolicy();
  console.log(`\n🏢 Phase 3 — ${pt(flowPolicy.phase_titles.tenants)}\n`);
  const entries: TenantDraft[] = [];
  const defaultTenant = withExecutionContext(
    'knowledge_steward',
    () => ensureDefaultTenantProfile(),
    'ecosystem_architect'
  );
  const wantsTenantSetup = isAffirmative(
    await ask(t('Register a tenant now? (y/N): ', 'テナントを今すぐ登録しますか? (y/N): '), 'n')
  );
  const tenantDirPath = tenantDir();
  if (!safeExistsSync(tenantDirPath)) safeMkdir(tenantDirPath, { recursive: true });
  entries.push({
    tenant_slug: defaultTenant.tenant_slug,
    tenant_id: defaultTenant.tenant_id,
    display_name: defaultTenant.display_name,
    status: defaultTenant.status,
    assigned_role: defaultTenant.assigned_role,
    created_at:
      typeof defaultTenant.metadata?.created_at === 'string'
        ? defaultTenant.metadata.created_at
        : nowIso(),
  });

  if (wantsTenantSetup) {
    let tenantSlug = '';
    while (!tenantSlug) {
      const slugInput = await ask(
        t('Tenant slug [e.g. acme-co]: ', 'テナント slug [例: acme-co]: '),
        ''
      );
      try {
        tenantSlug = normalizeTenantSlug(slugInput);
      } catch (error) {
        console.log(chalk.red(String(error)));
      }
    }
    const displayName = await ask(
      t('Tenant display name [required]: ', 'テナント表示名 [必須]: '),
      tenantSlug
    );
    const assignedRole = await ask('Your role in this tenant [strategist]: ', 'strategist');
    const purpose = await ask('Purpose / scope for this tenant [optional]: ');
    const createdAt = nowIso();

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
          allow_cross_distillation: false,
        },
        metadata: {
          onboarding_source: 'pnpm onboard',
        },
      },
      `onboarding-tenant-${tenantSlug}`
    );
  }

  state.tenants = { entries };
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'tenants']));
  state.current_phase = 'tutorial';
  state.updated_at = nowIso();
  await saveState(state);
}

async function runTutorialPhase(state: OnboardingState): Promise<void> {
  const flowPolicy = resolveOnboardingFlowPolicy();
  console.log(`\n🎓 Phase 4 — ${pt(flowPolicy.phase_titles.tutorial)}\n`);
  const modeInput = (
    await ask('Tutorial mode: simulate / apply / skipped [simulate]: ', 'simulate')
  )
    .trim()
    .toLowerCase();
  const mode: TutorialDraft['mode'] =
    modeInput === 'apply' ? 'apply' : modeInput === 'skipped' ? 'skipped' : 'simulate';
  const summary =
    mode === 'skipped'
      ? pt(flowPolicy.tutorial_skipped_message)
      : await ask(
          t(
            'Describe the first tutorial mission in one sentence: ',
            '最初のチュートリアル・ミッションを一文で説明してください: '
          ),
          pt(flowPolicy.tutorial_default_summary)
        );

  const planPath = path.join(onboardingRoot(), 'tutorial-plan.md');
  const planMarkdown = [
    `# ${pt(flowPolicy.tutorial_plan_title)}`,
    '',
    `- Mode: ${mode}`,
    `- Summary: ${summary}`,
    '',
    `## ${pt(flowPolicy.tutorial_next_step_title)}`,
    mode === 'apply'
      ? '- Review the plan and create a mission manually if the setup is ready.'
      : '- Run the tutorial as a dry-run first, then decide whether to promote it to a mission.',
    '',
  ].join('\n');

  await writeTextArtifact(planPath, planMarkdown, 'onboarding-tutorial-plan');

  state.tutorial = { mode, summary, plan_path: planPath };
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'tutorial']));
  state.current_phase = 'summary';
  state.updated_at = nowIso();
  await saveState(state);
}

async function runSummaryPhase(state: OnboardingState): Promise<void> {
  const flowPolicy = resolveOnboardingFlowPolicy();
  console.log(`\n📊 Phase 5 — ${pt(flowPolicy.phase_titles.summary)}\n`);
  const summary = buildSummaryMarkdown(state);
  const runbookSkill = generateOnboardingRunbookSkill({
    profileRoot: profileRoot(),
    identityName: state.identity?.name,
    agentId: state.identity?.agent_id,
    generatedAt: nowIso(),
  });
  await writeTextArtifact(summaryPath(), summary, 'onboarding-summary');
  state.completed_phases = Array.from(new Set([...state.completed_phases, 'summary']));
  state.status = 'complete';
  state.current_phase = 'summary';
  state.updated_at = nowIso();
  await saveState(state);

  const identity = state.identity;
  console.log(chalk.green(`✅ ${pt(flowPolicy.complete_message)}`));
  console.log(
    `Identity: ${identity?.name || 'Sovereign'} / ${identity?.agent_id || 'KYBERION-PRIME'}`
  );
  console.log(`Summary written to: ${summaryPath()}`);
  console.log(`Runbook skill written to: ${runbookSkill.skillPath}`);
  console.log(`State written to: ${statePath()}`);
  console.log(t('\nNext steps:', '\n次のステップ:'));
  if (state.reasoning && !state.reasoning.available) {
    console.log(
      t(
        '0. Configure a real reasoning backend with `pnpm reasoning:setup` before real work.',
        '0. 実運用の前に `pnpm reasoning:setup` で実際の推論バックエンドを設定してください。'
      )
    );
  }
  console.log(
    t(
      `1. Review the service connection drafts in \`${path.join(profileRoot(), 'connections')}/\`.`,
      `1. \`${path.join(profileRoot(), 'connections')}/\` のサービス接続ドラフトを確認してください。`
    )
  );
  console.log(
    t(
      `2. Review the tenant draft in \`${path.join(profileRoot(), 'tenants')}/\`.`,
      `2. \`${path.join(profileRoot(), 'tenants')}/\` のテナントドラフトを確認してください。`
    )
  );
  console.log(
    t(
      '3. If the tutorial should become real work, create a mission explicitly after review.',
      '3. チュートリアルを実作業にする場合は、レビュー後に明示的にミッションを作成してください。'
    )
  );
  console.log(
    t(
      '4. Re-run `pnpm surfaces reconcile` after the workspace is ready.',
      '4. ワークスペースの準備ができたら `pnpm surfaces reconcile` を再実行してください。'
    )
  );
}

function onboardingArtifactsMissing(state: OnboardingState, phase: OnboardingPhase): boolean {
  if (phase !== 'identity') {
    return false;
  }
  return (
    !safeExistsSync(identityPath()) ||
    !safeExistsSync(visionPath()) ||
    !safeExistsSync(agentIdentityPath())
  );
}

export async function runOnboarding(args: string[] = []): Promise<void> {
  process.env.MISSION_ROLE = 'sovereign_concierge';
  setRegisteredEnv('KYBERION_PERSONA', 'sovereign');
  const rootDir = pathResolver.rootDir();
  let customerSlug = customerResolver.activeCustomer();

  if (!customerSlug && interactive && !expressMode) {
    const wantsCustomer = isAffirmative(await ask('Set up a customer overlay now? (y/N): ', 'n'));
    if (wantsCustomer) {
      while (!customerSlug) {
        const slugInput = await ask('Customer slug [e.g. acme-corp]: ', '');
        try {
          createCustomer(slugInput);
          switchCustomer(slugInput);
          customerSlug = slugInput.trim();
          setRegisteredEnv('KYBERION_CUSTOMER', customerSlug);
        } catch (error) {
          console.log(chalk.red(String(error)));
        }
      }
    }
  }

  const personalDir = profileRoot();

  if (
    shouldRefuseNonInteractiveOnboarding({
      interactive,
      express: expressMode,
      allowDefaults: getRegisteredEnvText('KYBERION_ONBOARDING_NON_INTERACTIVE_OK'),
    })
  ) {
    console.error(
      chalk.red(
        t(
          '\n❌ Refusing to run interactive onboarding without a TTY.',
          '\n❌ TTY が無いため対話式オンボーディングの実行を拒否します。'
        )
      )
    );
    console.error(
      t(
        '  This wizard would otherwise silently apply default values for every prompt,',
        '  このまま実行すると、すべての質問に既定値が黙って適用され、'
      )
    );
    console.error(
      t(
        "  producing an identity that does not reflect the Sovereign's intent.",
        '  Sovereign の意図を反映しないアイデンティティが作られてしまいます。'
      )
    );
    console.error(t('\n  Options:', '\n  選択肢:'));
    console.error(
      t(
        '    1. Run from a real terminal: pnpm onboard',
        '    1. 実ターミナルから実行する: pnpm onboard'
      )
    );
    console.error(
      '    2. If you need a customer overlay, create it first with `pnpm customer:create <slug>`'
    );
    console.error('       and activate it with `pnpm customer:switch <slug>` before onboarding.');
    console.error(
      '    3. Use the agent Path B flow (CLAUDE.md → docs/.../onboarding.md): write the'
    );
    console.error(
      `       active profile root (${profileRoot()}/...) directly per the schemas under`
    );
    console.error('       knowledge/public/{schemas,templates}.');
    console.error(
      '    4. To intentionally accept defaults, re-run with KYBERION_ONBOARDING_NON_INTERACTIVE_OK=1'
    );
    rl.close();
    throw new ScriptExitError(2);
  }

  console.log(
    t(
      '\n🌟 Welcome to Kyberion Sovereign Awakening 🌟\n',
      '\n🌟 Kyberion Sovereign Awakening へようこそ 🌟\n'
    )
  );
  console.log(
    t(
      'This flow captures identity, service readiness, tenant scope, and a safe first tutorial.\n',
      'このフローでは、アイデンティティ、サービスの準備状態、テナントのスコープ、安全な最初のチュートリアルを設定します。\n'
    )
  );
  console.log(t('Estimated time: 5-10 minutes.', '所要時間の目安: 5〜10分。'));
  if (expressMode) {
    console.log(
      t(
        'Express mode: accept safe defaults now; refine identity and connections later with `pnpm onboard`.',
        'Express モード: 安全な既定値で開始し、後から `pnpm onboard` でアイデンティティと接続を調整します。'
      )
    );
  }
  console.log(
    t(
      'You can stop with Ctrl-C at any point and resume later.\n',
      'Ctrl-C でいつでも中断でき、後から再開できます。\n'
    )
  );

  if (!safeExistsSync(personalDir)) {
    safeMkdir(personalDir, { recursive: true });
  }
  if (!safeExistsSync(onboardingRoot())) {
    safeMkdir(onboardingRoot(), { recursive: true });
  }

  const isMenuMode = args.includes('--menu') || args.includes('--reconfig');

  let state = loadState();
  if (state?.identity?.language) {
    setWizardLanguage(state.identity.language);
  }

  const servicesOnly = args.includes('--services-only');
  const serviceArgIndex = args.indexOf('--service');
  const selectedService =
    serviceArgIndex >= 0 ? args[serviceArgIndex + 1]?.trim() || undefined : undefined;
  if (servicesOnly) {
    state ??= createInitialState();
    await runServicesPhase(state, selectedService ? [selectedService] : undefined);
    console.log(
      selectedService
        ? `Service connection draft updated: ${selectedService}`
        : 'Service connection drafts updated.'
    );
    rl.close();
    return;
  }

  if (isMenuMode || (state && state.status === 'complete' && interactive && !expressMode)) {
    console.log(chalk.bold.cyan(`\n${mt('onboarding_menu_title')}`));
    console.log(mt('onboarding_menu_item_identity'));
    console.log(mt('onboarding_menu_item_avatar'));
    console.log(mt('onboarding_menu_item_voice'));
    console.log(mt('onboarding_menu_item_knowledge'));
    console.log(mt('onboarding_menu_item_ping'));
    console.log(mt('onboarding_menu_item_guardrails'));
    console.log(mt('onboarding_menu_item_cadence'));
    console.log(mt('onboarding_menu_item_tutorial'));
    console.log(mt('onboarding_menu_item_restart'));
    console.log('---------------------------------------------------');
    const choice = (await ask(mt('onboarding_menu_prompt'), 'Q')).trim().toUpperCase();

    if (choice === '1' && state) {
      await runIdentityPhase(state);
      await runSummaryPhase(state);
      rl.close();
      return;
    } else if (choice === '2') {
      console.log(`\n${mt('onboarding_menu_running_avatar')}`);
      try {
        await runManagedMenuTask('avatar-pipeline', [
          'dist/scripts/run_pipeline.js',
          '--input',
          'knowledge/product/pipeline-templates/create-my-avatar.json',
        ]);
      } catch (e) {
        console.error(mt('onboarding_menu_error_avatar'), formatMenuTaskError(e));
      }
      rl.close();
      return;
    } else if (choice === '3') {
      console.log(`\n${mt('onboarding_menu_running_voice')}`);
      try {
        await runManagedMenuTask('voice-pipeline', [
          'dist/scripts/run_pipeline.js',
          '--input',
          'knowledge/product/pipeline-templates/clone-my-voice.json',
        ]);
      } catch (e) {
        console.error(mt('onboarding_menu_error_voice'), formatMenuTaskError(e));
      }
      rl.close();
      return;
    } else if (choice === '4') {
      console.log(`\n${mt('onboarding_menu_running_knowledge')}`);
      try {
        await runManagedMenuTask('knowledge-index', ['dist/scripts/generate_knowledge_index.js']);
      } catch (e) {
        console.error(mt('onboarding_menu_error_knowledge'), formatMenuTaskError(e));
      }
      rl.close();
      return;
    } else if (choice === '5') {
      console.log(`\n${mt('onboarding_menu_running_ping')}`);
      try {
        await runManagedMenuTask('setup-report', ['dist/scripts/setup_report.js']);
      } catch (e) {
        console.error(mt('onboarding_menu_error_ping'), formatMenuTaskError(e));
      }
      rl.close();
      return;
    } else if (choice === '6') {
      console.log(`\n${mt('onboarding_menu_running_guardrails')}`);
      try {
        await runManagedMenuTask('governance-check', ['dist/scripts/check_governance_rules.js']);
      } catch (e) {
        console.error(mt('onboarding_menu_error_guardrails'), formatMenuTaskError(e));
      }
      rl.close();
      return;
    } else if (choice === '7') {
      console.log(`\n${mt('onboarding_menu_running_cadence')}`);
      try {
        await runManagedMenuTask('schedule-list', [
          'dist/scripts/run_generation_schedule.js',
          '--action',
          'list',
        ]);
      } catch (e) {
        console.error(mt('onboarding_menu_error_cadence'), formatMenuTaskError(e));
      }
      rl.close();
      return;
    } else if (choice === '8' && state) {
      await runTutorialPhase(state);
      await runSummaryPhase(state);
      rl.close();
      return;
    } else if (choice === '9') {
      console.log(`\n${mt('onboarding_menu_running_restart')}`);
      state = createInitialState();
      await saveState(state);
    } else {
      console.log(mt('onboarding_menu_quit'));
      rl.close();
      return;
    }
  } else if (!state) {
    state = createInitialState();
    await saveState(state);
  } else {
    const resume = await ask(
      t(
        `Resume onboarding from phase "${state.current_phase}"? (Y/n): `,
        `フェーズ「${state.current_phase}」からオンボーディングを再開しますか?(Y/n): `
      ),
      'y'
    );
    if (!isAffirmative(resume)) {
      state = createInitialState();
      await saveState(state);
    }
  }

  for (const phase of PHASES) {
    if (state.completed_phases.includes(phase) && phase !== 'summary') {
      if (onboardingArtifactsMissing(state, phase)) {
        console.log(`completed 扱いだが成果物がありません。再実行します: ${phase}`);
      } else {
        continue;
      }
    }
    if (phase === 'identity') {
      await runIdentityPhase(state);
    } else if (phase === 'reasoning') {
      await runReasoningPhase(state);
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

  console.log(t('\nWelcome aboard.', '\nようこそ。'));
  console.log(`Workspace root: ${rootDir}`);
  rl.close();
}

export const runOnboardingScript = defineScript({
  name: 'onboard',
  flags: [],
  run: ({ argv }) => runOnboarding(argv),
});

if (
  isDirectScript(import.meta.url, 'onboarding_wizard.ts') ||
  isDirectScript(import.meta.url, 'onboarding_wizard.js')
)
  void runOnboardingScript();
