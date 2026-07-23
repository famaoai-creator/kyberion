import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { withExecutionContext } from './authority.js';
import {
  getAdapterDefaultSelectionSnapshot,
  saveAdapterDefaultPreferences,
  validateAdapterDefaultPreferences,
} from './adapter-default-selection.js';
import { loadProviderConfig } from './provider-config.js';
import { resolveActiveProfileRoot } from './profile-root.js';
import {
  getLlmSelectionSnapshot,
  saveLlmSelectionPreferences,
  validateLlmSelectionPreferences,
} from './llm-selection-preferences.js';
import { listServiceBindingRecords } from './service-binding-registry.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { withLock } from './src/lock-utils.js';
import { getToolRuntimePolicy } from './tool-runtime-policy.js';
import {
  getVoiceProfileRegistry,
  resetVoiceProfileRegistryCache,
} from './voice-profile-registry.js';

const interactionStyles = ['Senior Partner', 'Concierge', 'Minimalist'] as const;
const toolModes = ['trial_first', 'installed_first', 'installed_only'] as const;
const allowedServices = [
  'github',
  'google-workspace',
  'microsoft-365',
  'slack',
  'comfyui',
  'voice-hub',
  'browser',
] as const;

const identitySchema = z.object({
  name: z.string().trim().min(1).max(120),
  language: z.string().trim().min(2).max(16),
  interaction_style: z.enum(interactionStyles),
  primary_domain: z.string().trim().min(1).max(200),
  vision: z.string().trim().min(1).max(4000),
  agent_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9._-]{2,63}$/),
});

const voiceSchema = z
  .object({
    enabled: z.boolean().default(false),
    profile_id: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{2,63}$/)
      .optional(),
    display_name: z.string().trim().min(1).max(120).optional(),
    language: z.string().trim().min(2).max(16).default('ja'),
    engine_id: z.string().trim().min(1).max(120).default('mlx_audio_qwen3'),
    sample_refs: z.array(z.string().trim().min(1)).max(3).default([]),
  })
  .superRefine((value, context) => {
    if (!value.enabled) return;
    if (!value.profile_id)
      context.addIssue({ code: 'custom', message: 'voice profile_id is required' });
    if (!value.display_name)
      context.addIssue({ code: 'custom', message: 'voice display_name is required' });
    if (!value.sample_refs.length)
      context.addIssue({ code: 'custom', message: 'at least one voice sample is required' });
  });

const serviceSchema = z.object({
  service_id: z.enum(allowedServices),
  auth_mode: z.enum(['none', 'oauth', 'secret-guard', 'session']),
  required: z.boolean().default(false),
});

export const browserOnboardingDraftSchema = z
  .object({
    version: z.literal('1.0.0').default('1.0.0'),
    identity: identitySchema,
    voice: voiceSchema.default({
      enabled: false,
      language: 'ja',
      engine_id: 'mlx_audio_qwen3',
      sample_refs: [],
    }),
    services: z.array(serviceSchema).max(16).default([]),
    providers: z.object({
      priority: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
      default_models: z.record(z.string(), z.string().trim().min(1).max(160)).default({}),
    }),
    reasoning: z
      .object({
        provider: z.string().trim().min(1).max(80),
        model_id: z.string().trim().min(1).max(160).optional(),
      })
      .optional(),
    adapter_defaults: z
      .record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(200))
      .optional(),
    tools: z.object({
      mode_preference: z.object({
        python: z.enum(toolModes),
        node: z.enum(toolModes),
        system: z.enum(toolModes),
      }),
      install_requires_approval: z.boolean().default(true),
      pin_requires_approval: z.boolean().default(true),
    }),
    tutorial: z
      .object({
        mode: z.enum(['simulate', 'apply', 'skipped']).default('simulate'),
        summary: z.string().trim().max(1000).default('Run the first governed tutorial.'),
      })
      .default({ mode: 'simulate', summary: 'Run the first governed tutorial.' }),
  })
  .superRefine((value, context) => {
    if (new Set(value.providers.priority).size !== value.providers.priority.length) {
      context.addIssue({
        code: 'custom',
        path: ['providers', 'priority'],
        message: 'provider priority contains duplicates',
      });
    }
    if (new Set(value.services.map((entry) => entry.service_id)).size !== value.services.length) {
      context.addIssue({
        code: 'custom',
        path: ['services'],
        message: 'services contain duplicates',
      });
    }
  });

export type BrowserOnboardingDraft = z.infer<typeof browserOnboardingDraftSchema>;

export interface BrowserOnboardingPreview {
  ok: boolean;
  draft: BrowserOnboardingDraft;
  effects: Array<{ kind: string; path: string; description: string }>;
  warnings: string[];
  blockers: string[];
}

function profileRoot(): string {
  return resolveActiveProfileRoot();
}

function onboardingPath(name: string): string {
  return path.join(profileRoot(), 'onboarding', name);
}

function readJson<T>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  return JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))) as T;
}

function writeJson(filePath: string, value: unknown): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(value, null, 2));
}

function assertVoiceSampleRefs(sampleRefs: string[]): void {
  const sampleRoot = path.resolve(profileRoot(), 'voice', 'samples');
  for (const sampleRef of sampleRefs) {
    const resolved = path.resolve(sampleRef);
    if (resolved !== sampleRoot && !resolved.startsWith(`${sampleRoot}${path.sep}`)) {
      throw new Error(`voice sample is outside the active profile: ${sampleRef}`);
    }
    if (!safeExistsSync(resolved)) throw new Error(`voice sample does not exist: ${sampleRef}`);
  }
}

export function previewBrowserOnboarding(input: unknown): BrowserOnboardingPreview {
  const draft = browserOnboardingDraftSchema.parse(input);
  const providerConfig = loadProviderConfig();
  const knownProviders = new Set([
    ...providerConfig.default_priority,
    ...Object.keys(providerConfig.default_models),
  ]);
  const warnings = draft.providers.priority
    .filter((provider) => !knownProviders.has(provider))
    .map((provider) => `Provider '${provider}' is not in the installed provider catalog.`);
  if (draft.voice.enabled && draft.voice.sample_refs.length < 2) {
    warnings.push(
      'A single voice sample works, but two or three samples usually produce a more stable clone.'
    );
  }
  if (draft.reasoning) validateLlmSelectionPreferences(draft.reasoning);
  if (draft.adapter_defaults) validateAdapterDefaultPreferences(draft.adapter_defaults);

  const effects = [
    ['identity', path.join(profileRoot(), 'my-identity.json'), 'Update operator identity'],
    ['vision', path.join(profileRoot(), 'my-vision.md'), 'Update sovereign vision'],
    ['agent', path.join(profileRoot(), 'agent-identity.json'), 'Update agent identity'],
    ['providers', onboardingPath('provider-preferences.json'), 'Set provider and model priority'],
    ['reasoning', onboardingPath('llm-selection.json'), 'Set reasoning provider and model'],
    [
      'adapter-defaults',
      onboardingPath('adapter-defaults.json'),
      'Set adapter-backed runtime defaults',
    ],
    ['tools', onboardingPath('tool-runtime-policy.json'), 'Set tool runtime preference'],
    ['state', onboardingPath('browser-onboarding-state.json'), 'Record onboarding receipt'],
    ...draft.services.map((service) => [
      'service',
      path.join(profileRoot(), 'connections', `${service.service_id}.json`),
      `Create ${service.service_id} connection proposal`,
    ]),
    ...(draft.voice.enabled
      ? [
          [
            'voice',
            path.join(profileRoot(), 'voice', 'profile-registry.json'),
            `Register voice profile ${draft.voice.profile_id}`,
          ],
        ]
      : []),
  ].map(([kind, effectPath, description]) => ({ kind, path: effectPath, description }));

  return { ok: true, draft, effects, warnings, blockers: [] };
}

export async function applyBrowserOnboarding(input: unknown): Promise<{
  ok: true;
  applied_at: string;
  artifacts: string[];
  warnings: string[];
}> {
  const preview = previewBrowserOnboarding(input);
  const draft = preview.draft;
  if (draft.voice.enabled) assertVoiceSampleRefs(draft.voice.sample_refs);

  return withLock('browser-onboarding-apply', async () =>
    withExecutionContext(
      'sovereign_concierge',
      () => {
        const now = new Date().toISOString();
        const artifacts: string[] = [];
        const identityPath = path.join(profileRoot(), 'my-identity.json');
        writeJson(identityPath, {
          name: draft.identity.name,
          language: draft.identity.language,
          interaction_style: draft.identity.interaction_style,
          primary_domain: draft.identity.primary_domain,
          created_at: now,
          status: 'active',
          version: '1.0.0',
        });
        artifacts.push(identityPath);

        const visionPath = path.join(profileRoot(), 'my-vision.md');
        safeWriteFile(visionPath, `# Sovereign Vision\n\n${draft.identity.vision}\n`);
        artifacts.push(visionPath);

        const agentPath = path.join(profileRoot(), 'agent-identity.json');
        writeJson(agentPath, {
          agent_id: draft.identity.agent_id,
          version: '1.0.0',
          role: 'Ecosystem Architect / Senior Partner',
          owner: draft.identity.name,
          trust_tier: 'sovereign',
          created_at: now,
        });
        artifacts.push(agentPath);

        const providerPath = onboardingPath('provider-preferences.json');
        writeJson(providerPath, {
          version: '1.0.0',
          priority: draft.providers.priority,
          default_models: draft.providers.default_models,
          updated_at: now,
          source: 'browser-onboarding',
        });
        artifacts.push(providerPath);

        if (draft.reasoning) {
          const reasoningSelection = saveLlmSelectionPreferences(draft.reasoning);
          artifacts.push(reasoningSelection.storage_path);
        }

        if (draft.adapter_defaults) {
          const adapterDefaults = saveAdapterDefaultPreferences(draft.adapter_defaults);
          artifacts.push(adapterDefaults.storage_path);
        }

        const toolPath = onboardingPath('tool-runtime-policy.json');
        const baseToolPolicy = getToolRuntimePolicy();
        writeJson(toolPath, {
          ...baseToolPolicy,
          version: '1.0.0',
          mode_preference: draft.tools.mode_preference,
          approval: {
            install_requires_approval: draft.tools.install_requires_approval,
            pin_requires_approval: draft.tools.pin_requires_approval,
          },
        });
        artifacts.push(toolPath);

        for (const service of draft.services) {
          const servicePath = path.join(profileRoot(), 'connections', `${service.service_id}.json`);
          writeJson(servicePath, {
            version: '1.0.0',
            service_id: service.service_id,
            status: 'proposed',
            auth_mode: service.auth_mode,
            required: service.required,
            credential_ref: null,
            created_at: now,
            source: 'browser-onboarding',
          });
          artifacts.push(servicePath);
        }

        if (draft.voice.enabled) {
          const voicePath = path.join(profileRoot(), 'voice', 'profile-registry.json');
          const current = readJson<{
            version?: string;
            default_profile_id?: string;
            profiles?: any[];
          }>(voicePath);
          const profiles = new Map(
            (current?.profiles || []).map((profile) => [profile.profile_id, profile])
          );
          profiles.set(draft.voice.profile_id!, {
            profile_id: draft.voice.profile_id,
            display_name: draft.voice.display_name,
            tier: 'personal',
            languages: [draft.voice.language],
            sample_refs: draft.voice.sample_refs,
            default_engine_id: draft.voice.engine_id,
            status: 'active',
            notes: 'Registered through Browser Onboarding Studio',
          });
          writeJson(voicePath, {
            version: '1.0.0',
            default_profile_id: draft.voice.profile_id,
            profiles: [...profiles.values()],
          });
          resetVoiceProfileRegistryCache();
          artifacts.push(voicePath);
        }

        const statePath = onboardingPath('browser-onboarding-state.json');
        writeJson(statePath, {
          version: '1.0.0',
          status: 'complete',
          applied_at: now,
          identity: draft.identity,
          providers: draft.providers,
          reasoning: draft.reasoning || getLlmSelectionSnapshot().preferences,
          adapter_defaults:
            draft.adapter_defaults || getAdapterDefaultSelectionSnapshot().preferences.defaults,
          tools: draft.tools,
          services: draft.services,
          voice_profile_id: draft.voice.enabled ? draft.voice.profile_id : null,
          tutorial: draft.tutorial,
          artifacts,
        });
        artifacts.push(statePath);
        return { ok: true as const, applied_at: now, artifacts, warnings: preview.warnings };
      },
      'ecosystem_architect'
    )
  );
}

export function saveBrowserOnboardingVoiceSample(input: {
  profileId: string;
  contentType: string;
  data: Buffer;
}): { sample_ref: string; bytes: number; content_type: string } {
  const profileId = z
    .string()
    .regex(/^[a-z][a-z0-9-]{2,63}$/)
    .parse(input.profileId);
  const extensionByType: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
  };
  const contentType = String(input.contentType || '')
    .split(';', 1)[0]
    .toLowerCase();
  const extension = extensionByType[contentType];
  if (!extension) throw new Error(`unsupported voice sample content type: ${contentType}`);
  if (!input.data.length || input.data.length > 12 * 1024 * 1024) {
    throw new Error('voice sample must be between 1 byte and 12 MiB');
  }
  const sampleDir = path.join(profileRoot(), 'voice', 'samples', profileId);
  safeMkdir(sampleDir, { recursive: true });
  const samplePath = path.join(sampleDir, `sample-${randomUUID()}.${extension}`);
  withExecutionContext(
    'sovereign_concierge',
    () => safeWriteFile(samplePath, input.data),
    'ecosystem_architect'
  );
  return { sample_ref: samplePath, bytes: input.data.length, content_type: contentType };
}

export function getBrowserOnboardingState(): Record<string, unknown> {
  return withExecutionContext(
    'sovereign_concierge',
    () => {
      const providerConfig = loadProviderConfig();
      const providerPreference = readJson<Record<string, unknown>>(
        onboardingPath('provider-preferences.json')
      );
      const toolPreference = readJson<Record<string, unknown>>(
        onboardingPath('tool-runtime-policy.json')
      );
      return {
        ok: true,
        profile_root: profileRoot(),
        identity: readJson(path.join(profileRoot(), 'my-identity.json')),
        agent_identity: readJson(path.join(profileRoot(), 'agent-identity.json')),
        onboarding: readJson(onboardingPath('browser-onboarding-state.json')),
        providers: providerPreference || {
          version: 'default',
          priority: providerConfig.default_priority,
          default_models: providerConfig.default_models,
        },
        reasoning_selection: getLlmSelectionSnapshot(),
        adapter_defaults: getAdapterDefaultSelectionSnapshot(),
        tools: toolPreference || getToolRuntimePolicy(),
        voice_profiles: getVoiceProfileRegistry().profiles,
        service_bindings: listServiceBindingRecords(),
        allowed_services: allowedServices,
      };
    },
    'ecosystem_architect'
  );
}

export function loadOperatorProviderPreferences(): {
  priority: string[];
  default_models: Record<string, string>;
} | null {
  return withExecutionContext(
    'sovereign_concierge',
    () => {
      const value = readJson<{ priority?: string[]; default_models?: Record<string, string> }>(
        onboardingPath('provider-preferences.json')
      );
      if (!value?.priority?.length) return null;
      return { priority: value.priority, default_models: value.default_models || {} };
    },
    'ecosystem_architect'
  );
}
