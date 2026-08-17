/**
 * QM-06 live CLI compatibility evidence.
 *
 * The probe intentionally separates what can be exercised without spending a
 * model turn (binary/version/help) from capabilities that remain adapter
 * declarations (abort/session continuity/images). This keeps the matrix
 * useful in CI and prevents a successful `--help` call from overstating a
 * provider capability.
 */

import { safeExec } from './secure-io.js';
import {
  BACKEND_CAPABILITY_PROFILES,
  type BackendCapabilityProfile,
} from './backend-capability-profile.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';

const CLI_MODES = [
  'claude-cli',
  'codex-cli',
  'gemini-cli',
  'agy-cli',
  'grok-cli',
  'copilot',
] as const satisfies readonly ReasoningBackendMode[];

const CLI_BINARIES: Record<(typeof CLI_MODES)[number], string> = {
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'agy-cli': 'agy',
  'grok-cli': 'grok',
  copilot: 'copilot',
};

const BOOLEAN_CAPABILITIES = [
  'structured_output',
  'session_continuity',
  'abort',
  'images',
] as const satisfies readonly (keyof BackendCapabilityProfile['capabilities'])[];
type BooleanCapability = (typeof BOOLEAN_CAPABILITIES)[number];

export type ConformanceEvidenceStatus = 'verified' | 'declared' | 'unavailable';

export interface BackendConformanceResult {
  mode: ReasoningBackendMode;
  binary: string;
  profile: BackendCapabilityProfile;
  version: {
    status: ConformanceEvidenceStatus;
    output?: string;
    error?: string;
  };
  help: {
    status: ConformanceEvidenceStatus;
    output?: string;
    error?: string;
  };
  capabilities: Record<
    BooleanCapability,
    { declared: boolean; status: ConformanceEvidenceStatus; evidence: string }
  >;
}

export interface BackendConformanceReport {
  version: '1.0.0';
  generated_at: string;
  probe: 'live-cli-version-help';
  results: BackendConformanceResult[];
}

export type BackendConformanceExec = (
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputMB: number }
) => string;

function runProbe(
  exec: BackendConformanceExec,
  binary: string,
  args: string[]
): { status: ConformanceEvidenceStatus; output?: string; error?: string } {
  try {
    const output = exec(binary, args, { timeoutMs: 10_000, maxOutputMB: 1 }).trim().slice(0, 2_000);
    return { status: 'verified', output };
  } catch (error) {
    return {
      status: 'unavailable',
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
  }
}

function capabilityEvidence(
  profile: BackendCapabilityProfile,
  capability: BooleanCapability,
  help: BackendConformanceResult['help']
): { declared: boolean; status: ConformanceEvidenceStatus; evidence: string } {
  const declared = profile.capabilities[capability];
  if (capability === 'structured_output' && help.status === 'verified') {
    const helpText = help.output?.toLowerCase() || '';
    const markers = ['schema', 'json', 'structured'];
    if (markers.some((marker) => helpText.includes(marker))) {
      return {
        declared,
        status: 'verified',
        evidence: 'CLI help exposes a structured-output marker.',
      };
    }
  }
  return {
    declared,
    status: help.status === 'verified' ? 'declared' : 'unavailable',
    evidence:
      help.status === 'verified'
        ? 'Profile declaration retained; this capability needs a model-turn probe.'
        : 'CLI help was unavailable, so the profile declaration is not live evidence.',
  };
}

export function runBackendConformance(
  options: { exec?: BackendConformanceExec; now?: string } = {}
): BackendConformanceReport {
  const exec =
    options.exec || ((command, args, probeOptions) => safeExec(command, args, probeOptions));
  const results = CLI_MODES.map((mode) => {
    const binary = CLI_BINARIES[mode];
    const profile = BACKEND_CAPABILITY_PROFILES[mode];
    const version = runProbe(exec, binary, ['--version']);
    const help = runProbe(exec, binary, ['--help']);
    const capabilities = Object.fromEntries(
      BOOLEAN_CAPABILITIES.map((capability) => [
        capability,
        capabilityEvidence(profile, capability, help),
      ])
    ) as BackendConformanceResult['capabilities'];
    return { mode, binary, profile, version, help, capabilities };
  });
  return {
    version: '1.0.0',
    generated_at: options.now || new Date().toISOString(),
    probe: 'live-cli-version-help',
    results,
  };
}
