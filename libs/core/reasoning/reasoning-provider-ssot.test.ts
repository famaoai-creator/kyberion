/**
 * RS-01/RS-02/RS-03 contract: `knowledge/product/governance/reasoning-providers/*.json`
 * is the single source of truth for provider tables.
 *
 * 1. A synthetic provider that reuses an existing adapter is accepted
 *    end-to-end (registry, capability profile, readiness probe, conformance,
 *    egress, discovery, managed env, runtime notes) without code edits.
 * 2. An incomplete or unknown provider fails closed with an operator-visible reason.
 * 3. Drift guard: no non-test TS file re-hardcodes the CLI provider list.
 */
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { getAllFiles } from '../fs-utils.js';
import { resetRegistryDirectoryCacheForTests } from '../registry-directory.js';
import {
  explainReasoningProviderDescriptor,
  getReasoningProviderDescriptor,
  listCliReasoningProviderDescriptors,
  listReasoningProviderDescriptors,
  reasoningProviderModelEnvKeys,
  reasoningProviderRegistryOverridesAllowed,
  resetReasoningProviderRegistryForTests,
} from './reasoning-provider-registry.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import {
  backendCapabilityProfile,
  backendCapabilityProfileForIdentifier,
  isLocalOnlyReasoningBackend,
} from '../backend-capability-profile.js';
import { probeExplicitReasoningBackend } from '../environment-capability-probes.js';
import { runBackendConformance, runBackendSandboxConformance } from '../backend-conformance.js';
import { reasoningBackendEndpoint } from './reasoning-egress-scope.js';
import { providerIdForReasoningIdentifier } from '../provider/provider-egress-gate.js';
import { isCliDiscoveryMode } from './cli-mode-presence.js';
import { getManagedProviderCliDefinition } from '../provider/provider-managed-env.js';
import { providerCliBinary } from '../provider/provider-binary-map.js';
import { runtimeInstructionsForProvider } from './reasoning-runtime-instructions.js';
import { buildApiProviderBundle } from './reasoning-api-provider.js';
import {
  providerToCompilerProvider,
  resolveIntentCompilerTarget,
} from '../intent/intent-contract.js';
import { resolveAgentModelArgs } from '../agent/agent-prompt-response.js';
import { resolveCodexModelForTier } from '../provider/codex-cli-query.js';
import { loadProviderConfig, resolveRuntimeEndpoint } from '../provider/provider-config.js';

const SOURCE_DIR = pathResolver.knowledge('product/governance/reasoning-providers');
const SYNTHETIC_MODE = 'acme-cli' as ReasoningBackendMode;

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))) as Record<
    string,
    unknown
  >;
}

function syntheticDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: SYNTHETIC_MODE,
    provider: 'acme',
    module: './reasoning/reasoning-cli-provider',
    capabilities: {
      reasoning: true,
      structured_output: true,
      abort: true,
      session_continuity: false,
      input_modalities: ['text'],
    },
    env_keys: [],
    cost_tier: 'free',
    transport: 'cli',
    data_egress: 'external-api',
    adapter: 'provider-cli',
    profile: {
      streaming: false,
      tool_calling: true,
      native_subagent: false,
      thinking_levels: { low: 'low', medium: 'medium', high: 'high' },
      supports_strict_tools: false,
      supports_grammar_tools: false,
      utility_fit: ['classify'],
    },
    aliases: ['shell-acme-cli'],
    endpoint: 'https://api.acme.example',
    egress_provider_id: 'acme',
    model_env_keys: ['KYBERION_REASONING_MODEL'],
    runtime_instructions: ['Provider note: acme synthetic note.'],
    cli: {
      binary: 'acme',
      version_args: ['--version'],
      help_args: ['--help'],
      discovery: true,
      sandbox: { args: ['-p', '{prompt}', '{permission_args}'] },
      install: { brew_formula: 'acme', hint: 'Install the Acme CLI.' },
    },
    ...overrides,
  };
}

describe('reasoning provider registry is the single source of truth (RS-01)', () => {
  const root = pathResolver.sharedTmp(`reasoning-provider-ssot-${process.pid}-${Date.now()}`);
  const previousDir = process.env.KYBERION_REASONING_PROVIDER_REGISTRY_DIR;

  function seedRegistry(extra: Record<string, unknown>): void {
    safeMkdir(root, { recursive: true });
    const index = readJson(path.join(SOURCE_DIR, 'index.json')) as { order: string[] };
    for (const mode of index.order) {
      safeWriteFile(
        path.join(root, `${mode}.json`),
        String(safeReadFile(path.join(SOURCE_DIR, `${mode}.json`), { encoding: 'utf8' }))
      );
    }
    safeWriteFile(
      path.join(root, `${SYNTHETIC_MODE}.json`),
      JSON.stringify({ version: '1.0.0', providers: [extra] }, null, 2)
    );
    safeWriteFile(
      path.join(root, 'index.json'),
      JSON.stringify({ version: '1.0.0', order: [...index.order, SYNTHETIC_MODE] }, null, 2)
    );
    process.env.KYBERION_REASONING_PROVIDER_REGISTRY_DIR = root;
    resetRegistryDirectoryCacheForTests();
    resetReasoningProviderRegistryForTests();
  }

  beforeEach(() => resetReasoningProviderRegistryForTests());

  afterEach(() => {
    if (previousDir === undefined) delete process.env.KYBERION_REASONING_PROVIDER_REGISTRY_DIR;
    else process.env.KYBERION_REASONING_PROVIDER_REGISTRY_DIR = previousDir;
    resetRegistryDirectoryCacheForTests();
    resetReasoningProviderRegistryForTests();
    safeRmSync(root, { recursive: true, force: true });
  });

  it('accepts a JSON-only provider on an existing adapter end-to-end', async () => {
    seedRegistry(syntheticDescriptor());

    expect(getReasoningProviderDescriptor(SYNTHETIC_MODE)).toMatchObject({
      provider: 'acme',
      adapter: 'provider-cli',
    });
    expect(backendCapabilityProfile(SYNTHETIC_MODE)).toMatchObject({
      transport: 'cli',
      data_egress: 'external-api',
      utility_fit: ['classify'],
    });
    expect(backendCapabilityProfileForIdentifier('shell-acme-cli')?.mode).toBe(SYNTHETIC_MODE);
    expect(isLocalOnlyReasoningBackend(SYNTHETIC_MODE)).toBe(false);

    const probed: Array<[string, readonly string[]]> = [];
    await expect(
      probeExplicitReasoningBackend(
        SYNTHETIC_MODE,
        {},
        {
          binaryProbe: (command, args) => {
            probed.push([command, args]);
            return true;
          },
        }
      )
    ).resolves.toEqual({ available: true });
    expect(probed).toEqual([['acme', ['--version']]]);

    const conformanceCalls: string[] = [];
    const report = runBackendConformance({
      exec: (command, args) => {
        conformanceCalls.push(`${command} ${args.join(' ')}`);
        return 'ok';
      },
    });
    expect(report.results.map((result) => result.mode)).toContain(SYNTHETIC_MODE);
    expect(conformanceCalls).toEqual(expect.arrayContaining(['acme --version', 'acme --help']));

    // Sandbox enforcement needs a provider permission profile (adapter data);
    // a provider without one is reported unsupported, never silently skipped.
    const sandbox = runBackendSandboxConformance({
      binaryAvailable: () => true,
      fs: { mkdir: () => undefined, exists: () => false, remove: () => undefined },
      exec: () => ({ stdout: '', stderr: '', status: 1 }),
    });
    expect(sandbox.find((result) => result.mode === SYNTHETIC_MODE)).toMatchObject({
      status: 'unsupported',
      binary: 'acme',
    });

    expect(reasoningBackendEndpoint(SYNTHETIC_MODE)).toBe('https://api.acme.example');
    expect(reasoningBackendEndpoint('shell-acme-cli')).toBe('https://api.acme.example');
    expect(providerIdForReasoningIdentifier(SYNTHETIC_MODE)).toBe('acme');
    expect(isCliDiscoveryMode(SYNTHETIC_MODE)).toBe(true);
    expect(getManagedProviderCliDefinition('acme')).toBeNull(); // no bin_env_key → not managed
    expect(providerCliBinary(SYNTHETIC_MODE)).toBe('acme');
    expect(reasoningProviderModelEnvKeys(SYNTHETIC_MODE)).toEqual(['KYBERION_REASONING_MODEL']);
    expect(runtimeInstructionsForProvider(SYNTHETIC_MODE)).toEqual([
      'Provider note: acme synthetic note.',
    ]);
  });

  it('fails closed with an operator-visible reason for an incomplete provider', () => {
    const { cli: _cli, ...withoutCli } = syntheticDescriptor();
    seedRegistry(withoutCli);
    expect(() => listReasoningProviderDescriptors()).toThrow(
      /\[REASONING_PROVIDER_REGISTRY_INVALID\] acme-cli: cli block is missing/
    );
  });

  it('rejects an adapter outside the governed adapter set', () => {
    seedRegistry(syntheticDescriptor({ adapter: 'acme-proprietary' }));
    expect(() => listReasoningProviderDescriptors()).toThrow(/REASONING_PROVIDER_REGISTRY|adapter/);
  });

  it('rejects data_egress that contradicts the declared endpoint (S3)', () => {
    expect(
      explainReasoningProviderDescriptor(
        syntheticDescriptor({ data_egress: 'local-only', endpoint: 'https://api.acme.example' })
      )
    ).toEqual({
      reason: expect.stringMatching(/local-only requires a loopback\/private endpoint/),
    });
    for (const endpoint of ['https://localhost', 'https://127.0.0.1', 'https://192.168.1.20']) {
      expect(explainReasoningProviderDescriptor(syntheticDescriptor({ endpoint }))).toEqual({
        reason: expect.stringMatching(/external-api must not use a loopback/),
      });
    }
    expect(
      explainReasoningProviderDescriptor(
        syntheticDescriptor({ data_egress: 'local-only', endpoint: 'https://10.0.0.5' })
      )
    ).toHaveProperty('descriptor');
    expect(explainReasoningProviderDescriptor(syntheticDescriptor())).toHaveProperty('descriptor');
  });

  it('ignores registry overrides under NODE_ENV=production (S3)', () => {
    seedRegistry(syntheticDescriptor());
    expect(getReasoningProviderDescriptor(SYNTHETIC_MODE)).toBeDefined();
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(reasoningProviderRegistryOverridesAllowed()).toBe(false);
      resetRegistryDirectoryCacheForTests();
      resetReasoningProviderRegistryForTests();
      expect(getReasoningProviderDescriptor(SYNTHETIC_MODE)).toBeUndefined();
      expect(getReasoningProviderDescriptor('claude-cli' as ReasoningBackendMode)).toBeDefined();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
    expect(reasoningProviderRegistryOverridesAllowed()).toBe(true);
  });

  it('treats an unknown identifier as unknown everywhere (fail closed)', async () => {
    expect(getReasoningProviderDescriptor('nope-cli' as ReasoningBackendMode)).toBeUndefined();
    expect(() => backendCapabilityProfile('nope-cli' as ReasoningBackendMode)).toThrow(
      /BACKEND_CAPABILITY_PROFILE_UNKNOWN/
    );
    expect(reasoningBackendEndpoint('nope-cli')).toBe('https://nope-cli.unknown-provider.invalid');
    expect(providerIdForReasoningIdentifier('nope-cli')).toBeUndefined();
    expect(isCliDiscoveryMode('nope-cli')).toBe(false);
    const result = await probeExplicitReasoningBackend('nope-cli', {}, { binaryProbe: () => true });
    expect(result.available).toBe(false);
  });
});

describe('governed provider descriptors (RS-01)', () => {
  afterEach(() => resetReasoningProviderRegistryForTests());

  it('probes copilot through the same declared binary in every consumer', async () => {
    const copilot = getReasoningProviderDescriptor('copilot');
    expect(copilot?.cli?.binary).toBe('gh');
    const envProbe: Array<[string, readonly string[]]> = [];
    await probeExplicitReasoningBackend(
      'copilot',
      {},
      { binaryProbe: (command, args) => (envProbe.push([command, args]), true) }
    );
    const conformance: string[] = [];
    runBackendConformance({
      exec: (command, args) => {
        conformance.push(`${command} ${args.join(' ')}`);
        return 'ok';
      },
    });
    expect(envProbe[0]?.[0]).toBe('gh');
    expect(conformance).toContain('gh copilot -- --help');
    expect(conformance.some((call) => call.startsWith('copilot '))).toBe(false);
  });

  it('declares a cli block for every cli-transport provider and an endpoint for named egress', () => {
    for (const descriptor of listReasoningProviderDescriptors()) {
      if (descriptor.transport === 'cli') expect(descriptor.cli, descriptor.mode).toBeDefined();
      if (descriptor.egress_provider_id) {
        expect(descriptor.endpoint, descriptor.mode).toMatch(/^https:\/\//u);
      }
    }
    expect(listCliReasoningProviderDescriptors().length).toBeGreaterThanOrEqual(9);
  });
});

describe('registry-driven provider lookups (RS-03)', () => {
  it('maps vendors, aliases and provider ids to compiler adapters; unknown is unsupported', () => {
    expect(providerToCompilerProvider('openai')).toBe('codex');
    expect(providerToCompilerProvider('anthropic')).toBe('claude');
    expect(providerToCompilerProvider('google')).toBe('gemini');
    expect(providerToCompilerProvider('xai')).toBeNull();
    expect(() => resolveIntentCompilerTarget({ provider: 'acme' })).toThrow(
      /INTENT_COMPILER_PROVIDER_UNSUPPORTED/
    );
    expect(resolveIntentCompilerTarget({ provider: 'anthropic', model: 'm' })).toEqual({
      provider: 'claude',
      model: 'm',
    });
  });

  it('resolves provider-id endpoints without a caller-side provider ladder', () => {
    expect(reasoningBackendEndpoint('claude')).toBe('https://api.anthropic.com');
    expect(reasoningBackendEndpoint('agy')).toBe('https://generativelanguage.googleapis.com');
    expect(reasoningBackendEndpoint('grok')).toBe('https://api.x.ai');
  });

  it('forwards a model flag only for CLIs that declare one', () => {
    expect(resolveAgentModelArgs('claude', 'claude', 'claude-opus-5-5')).toEqual([
      '--model',
      'claude-opus-5-5',
    ]);
    expect(resolveAgentModelArgs('claude', 'claude', 'claude')).toEqual([]);
    expect(resolveAgentModelArgs('codex', 'codex', 'gpt-x')).toEqual([]);
    expect(resolveAgentModelArgs('acme', 'acme', 'm')).toEqual([]);
  });

  it('fails closed for an API-module mode without a hosted-API builder', () => {
    expect(buildApiProviderBundle({ mode: 'codex-cli' })).toBeUndefined();
  });
});

describe('runtime model roles come from provider-config.json (RS-02)', () => {
  it('routes codex/gemini/grok/image/ollama defaults through governed roles', () => {
    const config = loadProviderConfig();
    expect(resolveCodexModelForTier('fast', 'x')).toBe(config.runtime_defaults['codex-fast']);
    expect(config.runtime_defaults['gemini-default']).toBe(config.default_models.gemini);
    expect(config.lifecycle.gemini?.default_model).toBe(config.runtime_defaults['gemini-default']);
    for (const role of ['grok-default', 'gemini-image', 'ollama-vision'] as const) {
      expect(config.runtime_defaults[role], role).toBeTruthy();
    }
    expect(resolveRuntimeEndpoint('ollama')).toMatch(/^http:\/\/localhost:\d+$/u);
    expect(() => resolveRuntimeEndpoint('acme')).toThrow(/PROVIDER_CONFIG_ENDPOINT_MISSING/);
  });
});

describe('provider-list drift guard (RS-01)', () => {
  /**
   * The compile-time mode union is the only sanctioned in-code vocabulary;
   * runtime gating and every per-provider table derive from the registry.
   */
  const ALLOWLIST = new Set(['libs/core/reasoning/reasoning-backend-policy.ts']);
  const THRESHOLD = 4;

  it('no non-test TS file hardcodes a list of CLI provider modes', () => {
    const cliModes = listCliReasoningProviderDescriptors().map((descriptor) => descriptor.mode);
    const offenders: string[] = [];
    for (const dir of ['libs', 'scripts']) {
      for (const file of getAllFiles(pathResolver.rootResolve(dir))) {
        const relative = path.relative(pathResolver.rootDir(), file).split(path.sep).join('/');
        if (!/\.(?:ts|tsx)$/u.test(relative) || /\.test\.tsx?$/u.test(relative)) continue;
        if (/(?:^|\/)(?:node_modules|dist|__tests__)\//u.test(relative)) continue;
        if (ALLOWLIST.has(relative)) continue;
        const text = String(safeReadFile(file, { encoding: 'utf8' }));
        const found = cliModes.filter(
          (mode) => text.includes(`'${mode}'`) || text.includes(`"${mode}"`)
        );
        if (found.length >= THRESHOLD) offenders.push(`${relative}: ${found.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 60_000);
});
