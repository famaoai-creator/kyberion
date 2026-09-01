/**
 * generate_subagent_definitions.ts — CT-01: role -> CLI subagent definition
 * generation ceremony (CLI_SUBAGENT_TEAM_PLAN_2026-07-25.ja.md §3 CT-01).
 *
 * Projects Kyberion's runtime-independent team contracts onto provider
 * subagent mechanisms: `.claude/agents/<role>.md` and AGY's
 * `.agents/agents/<name>/agent.md` files generated from
 *   - knowledge/product/orchestration/team-roles/<role>.json (team-role SSoT:
 *     description, compatible_authority_roles)
 *   - knowledge/product/roles/<authority-role>/PROCEDURE.md (condensed into
 *     the generated body when present)
 *   - libs/core/subagent-capability-profiles.ts (KD-05 capability tiers —
 *     the SSoT for both the team-role -> tier mapping
 *     (`resolveCapabilityProfileForTeamRole`) and the tier -> CLI `tools:`
 *     frontmatter projection (`SUBAGENT_PROFILE_CLI_TOOLS`), barrel-exported
 *     from `@agent/core`. `PROFILE_SPECS` below only adds the
 *     script-local framing lookup keyed by the same profile names.)
 *   - libs/core/working-principles.ts (buildWorkingPrinciplesLines)
 *
 * Generated files are committed artifacts, never hand-edited (each file
 * carries its own "DO NOT EDIT BY HAND" header). `--check` regenerates
 * in-memory and diffs against the files on disk — same shape as
 * `generate_op_registry.ts --check` / `generate:op-registry -- --check`.
 *
 * Usage:
 *   pnpm agents:generate                 — write Claude and AGY definitions
 *   pnpm agents:generate -- --check      — fail if any definition drifted
 */

import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import {
  DEFAULT_TEAM_ROLE_CAPABILITY_PROFILE,
  SUBAGENT_CAPABILITY_PROFILES,
  SUBAGENT_PROFILE_CLI_TOOLS,
} from '@agent/core/subagent-capability-profiles';
import {
  SUBAGENT_SECURE_IO_CONSTRAINT,
  SUBAGENT_SHARED_DIRECTORY_RULES_LINES,
} from '@agent/core/subagent-prompt-framing';
import { buildWorkingPrinciplesLines } from '@agent/core/working-principles';
import {
  renderRuntimeInstructions,
  runtimeInstructionsForProvider,
} from '@agent/core/reasoning-runtime-instructions';
import { loadTeamRoleIndex } from '@agent/core/mission-team-index';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveCapabilityProfileForTeamRole } from '@agent/core/subagent-capability-profiles';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { defineGenerator, isDirectScript } from './lib/harness.js';
import {
  buildAgyAgentDefinitionSource,
  extractAgentDefinitionBody,
  agyAgentName,
  type AgyAgentProfile,
} from './agy-agent-definition-adapter.js';

export type SubagentProfileName = 'implementer' | 'explorer' | 'planner';

interface ProfileSpec {
  /** CLI `tools:` frontmatter allowlist for this KD-05 tier. */
  readonly tools: readonly string[];
  /**
   * `SUBAGENT_CAPABILITY_PROFILES[].systemPromptPrefix` from
   * libs/core/subagent-capability-profiles.ts — the KD-05 capability-framing
   * sentence every generated definition must carry.
   */
  readonly framing: string;
}

// KD-05 profile -> { CLI tools:, framing } projection, derived from the SSoT
// registry (libs/core/subagent-capability-profiles.ts) instead of a
// hand-mirrored table. Adding/renaming a tier there flows through here
// automatically.
export const PROFILE_SPECS: Readonly<Record<SubagentProfileName, ProfileSpec>> = Object.fromEntries(
  SUBAGENT_CAPABILITY_PROFILES.map((profile) => [
    profile.name,
    {
      tools: SUBAGENT_PROFILE_CLI_TOOLS[profile.name] ?? [],
      framing: profile.systemPromptPrefix,
    },
  ])
) as Readonly<Record<SubagentProfileName, ProfileSpec>>;

export const DEFAULT_PROFILE: SubagentProfileName =
  DEFAULT_TEAM_ROLE_CAPABILITY_PROFILE as SubagentProfileName;

// XP-04 §"The read/write matrix" projection, re-exported from the shared
// framing SSoT (libs/core/subagent-prompt-framing.ts) so this committed
// generation ceremony and the runtime `--agents` projection (CN-02,
// libs/core/claude-native-subagent.ts) quote the same text.
export const SHARED_DIRECTORY_RULES_LINES: readonly string[] =
  SUBAGENT_SHARED_DIRECTORY_RULES_LINES;

// The representative roles this ceremony generates definitions for today
// (CT-01 acceptance criterion 1: implementer / an explorer-tier analysis
// role / devils_advocate). Add a role here to bring it under drift check;
// resolveCapabilityProfileForTeamRole (libs/core/subagent-capability-profiles.ts)
// controls which tier it gets.
export const GENERATED_ROLES: readonly string[] = ['implementer', 'reviewer', 'devils_advocate'];

interface TeamRoleDefinition {
  role: string;
  description: string;
  compatible_authority_roles?: string[];
  [key: string]: unknown;
}

function loadTeamRole(role: string): TeamRoleDefinition {
  const filePath = pathResolver.knowledge(`product/orchestration/team-roles/${role}.json`);
  const teamRole = loadTeamRoleIndex()[role];
  if (!teamRole) {
    throw new Error(`[SSOT_MISSING] No team-role definition at ${filePath}`);
  }
  return { role, ...teamRole };
}

export function resolveProfile(role: string): SubagentProfileName {
  return resolveCapabilityProfileForTeamRole(role) as SubagentProfileName;
}

function loadProcedureMarkdown(authorityRole: string | undefined): string | null {
  if (!authorityRole) return null;
  const filePath = pathResolver.knowledge(`product/roles/${authorityRole}/PROCEDURE.md`);
  if (!safeExistsSync(filePath)) return null;
  return String(safeReadFile(filePath, { encoding: 'utf8' }) || '') || null;
}

/**
 * Condense a PROCEDURE.md into its headings and bullet lines, in source
 * order, capped at `maxLines` — a deterministic (no summarization, no
 * locale-sensitive sort) reduction so the generated file stays reviewable.
 */
export function condenseProcedure(markdown: string, maxLines = 14): string[] {
  const picked: string[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line) || /^[-*]\s/.test(line)) {
      picked.push(line);
    }
    if (picked.length >= maxLines) break;
  }
  return picked;
}

function renderFrontmatter(role: string, description: string, tools: readonly string[]): string {
  const toolsValue = tools.length > 0 ? tools.join(', ') : "''";
  return [
    '---',
    `name: ${role}`,
    `description: ${description}`,
    `tools: ${toolsValue}`,
    '---',
  ].join('\n');
}

/** Pure, side-effect-free: builds the markdown body for one role's definition. */
export function buildAgentDefinitionSource(role: string, provider = 'claude'): string {
  const teamRole = loadTeamRole(role);
  const profileName = resolveProfile(role);
  const spec = PROFILE_SPECS[profileName];
  const authorityRole = teamRole.compatible_authority_roles?.[0];
  const procedureMd = loadProcedureMarkdown(authorityRole);
  const condensed = procedureMd ? condenseProcedure(procedureMd) : [];
  const principlesLines = buildWorkingPrinciplesLines(role);

  const lines: string[] = [];
  lines.push(renderFrontmatter(role, teamRole.description ?? role, spec.tools));
  lines.push('');
  lines.push('<!--');
  lines.push('GENERATED FILE — DO NOT EDIT BY HAND.');
  lines.push('Regenerate with: pnpm agents:generate');
  lines.push('Check drift with: pnpm agents:generate -- --check');
  lines.push('Sources (SSoT):');
  lines.push(`  - knowledge/product/orchestration/team-roles/${role}.json`);
  if (authorityRole) {
    lines.push(`  - knowledge/product/roles/${authorityRole}/PROCEDURE.md`);
  }
  lines.push('  - libs/core/subagent-capability-profiles.ts (KD-05 capability tiers)');
  lines.push('  - libs/core/working-principles.ts (buildWorkingPrinciplesLines)');
  lines.push(
    '  - knowledge/product/governance/multi-provider-coexecution-contract.md (XP-04 read/write matrix)'
  );
  lines.push('  Generator: scripts/generate_subagent_definitions.ts');
  lines.push('-->');
  lines.push('');
  lines.push(`# ${role} — CLI subagent (KD-05 "${profileName}" tier)`);
  lines.push('');
  lines.push(spec.framing);
  lines.push('');
  lines.push(...principlesLines);
  lines.push('');
  lines.push(renderRuntimeInstructions(runtimeInstructionsForProvider(provider)));
  if (condensed.length > 0 && authorityRole) {
    lines.push(
      `## Role procedure (condensed from knowledge/product/roles/${authorityRole}/PROCEDURE.md)`
    );
    lines.push('');
    lines.push(...condensed);
    lines.push('');
  }
  lines.push('## secure-io constraint');
  lines.push('');
  lines.push(SUBAGENT_SECURE_IO_CONSTRAINT);
  lines.push('');
  lines.push(...SHARED_DIRECTORY_RULES_LINES);
  return lines.join('\n');
}

const AGENTS_DIR = pathResolver.rootResolve('.claude/agents');
const AGY_AGENTS_DIR = pathResolver.rootResolve('.agents/agents');

function targetPath(role: string): string {
  return path.join(AGENTS_DIR, `${role}.md`);
}

function agyTargetPath(role: string): string {
  return path.join(AGY_AGENTS_DIR, agyAgentName(role), 'agent.md');
}

async function formatMarkdown(content: string, filePath: string): Promise<string> {
  const config = (await resolvePrettierConfig(filePath)) ?? {};
  return prettierFormat(content, { ...config, parser: 'markdown' });
}

/** Regenerates every GENERATED_ROLES definition in-memory (role -> final file bytes). */
export async function buildGeneratedFiles(): Promise<Map<string, string>> {
  const built = new Map<string, string>();
  for (const role of GENERATED_ROLES) {
    const raw = buildAgentDefinitionSource(role, 'claude');
    const formatted = await formatMarkdown(raw, targetPath(role));
    built.set(role, formatted);
  }
  return built;
}

/** Build the AGY-specific projection from the same canonical role output. */
export async function buildGeneratedAgyFiles(): Promise<Map<string, string>> {
  const built = new Map<string, string>();
  for (const role of GENERATED_ROLES) {
    const source = buildAgentDefinitionSource(role, 'agy');
    const description = source.match(/^description:\s*(.*)$/m)?.[1]?.trim() || role;
    const profile = resolveProfile(role) as AgyAgentProfile;
    const raw = buildAgyAgentDefinitionSource({
      role,
      description: description.replace(/^['"]|['"]$/g, ''),
      profile,
      body: extractAgentDefinitionBody(source),
    });
    built.set(role, await formatMarkdown(raw, agyTargetPath(role)));
  }
  return built;
}

export const main = defineGenerator({
  id: 'subagent-definitions',
  outputs: GENERATED_ROLES.flatMap((role) => [targetPath(role), agyTargetPath(role)]),
  executionContext: 'generate_subagent_definitions',
  async render() {
    const built = await buildGeneratedFiles();
    const agyBuilt = await buildGeneratedAgyFiles();
    return [
      ...Array.from(built, ([role, content]) => ({ path: targetPath(role), content })),
      ...Array.from(agyBuilt, ([role, content]) => ({ path: agyTargetPath(role), content })),
    ];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_subagent_definitions.ts') ||
  isDirectScript(import.meta.url, 'generate_subagent_definitions.js')
)
  void main();
