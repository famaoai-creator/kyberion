/**
 * generate_subagent_definitions.ts — CT-01: role -> CLI subagent definition
 * generation ceremony (CLI_SUBAGENT_TEAM_PLAN_2026-07-25.ja.md §3 CT-01).
 *
 * Projects Kyberion's runtime-independent team contracts onto Claude Code's
 * subagent mechanism: `.claude/agents/<role>.md` files generated from
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
 * `generate_op_registry.ts --check` / `check:op-registry`.
 *
 * Usage:
 *   pnpm agents:generate                 — write .claude/agents/<role>.md
 *   pnpm check:subagent-definitions      — fail if any file drifted
 */

import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import {
  DEFAULT_TEAM_ROLE_CAPABILITY_PROFILE,
  SUBAGENT_CAPABILITY_PROFILES,
  SUBAGENT_PROFILE_CLI_TOOLS,
  buildWorkingPrinciplesLines,
  pathResolver,
  resolveCapabilityProfileForTeamRole,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

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
  if (!safeExistsSync(filePath)) {
    throw new Error(`[SSOT_MISSING] No team-role definition at ${filePath}`);
  }
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  return JSON.parse(raw) as TeamRoleDefinition;
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
export function buildAgentDefinitionSource(role: string): string {
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
  lines.push('Check drift with: pnpm check:subagent-definitions');
  lines.push('Sources (SSoT):');
  lines.push(`  - knowledge/product/orchestration/team-roles/${role}.json`);
  if (authorityRole) {
    lines.push(`  - knowledge/product/roles/${authorityRole}/PROCEDURE.md`);
  }
  lines.push('  - libs/core/subagent-capability-profiles.ts (KD-05 capability tiers)');
  lines.push('  - libs/core/working-principles.ts (buildWorkingPrinciplesLines)');
  lines.push('  Generator: scripts/generate_subagent_definitions.ts');
  lines.push('-->');
  lines.push('');
  lines.push(`# ${role} — CLI subagent (KD-05 "${profileName}" tier)`);
  lines.push('');
  lines.push(spec.framing);
  lines.push('');
  lines.push(...principlesLines);
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
  lines.push(
    'All file I/O goes through `@agent/core` secure-io helpers — never call `node:fs` directly. Write only within your assigned task scope; never mutate mission-wide or goal state directly. Prefer an existing `pnpm pipeline` or a typed CLI over ad-hoc file edits when one already covers the task (see `pipelines/README.md`, `CAPABILITIES_GUIDE.md`).'
  );
  lines.push('');
  return lines.join('\n');
}

const AGENTS_DIR = pathResolver.rootResolve('.claude/agents');

function targetPath(role: string): string {
  return path.join(AGENTS_DIR, `${role}.md`);
}

async function formatMarkdown(content: string, filePath: string): Promise<string> {
  const config = (await resolvePrettierConfig(filePath)) ?? {};
  return prettierFormat(content, { ...config, parser: 'markdown' });
}

/** Regenerates every GENERATED_ROLES definition in-memory (role -> final file bytes). */
export async function buildGeneratedFiles(): Promise<Map<string, string>> {
  const built = new Map<string, string>();
  for (const role of GENERATED_ROLES) {
    const raw = buildAgentDefinitionSource(role);
    const formatted = await formatMarkdown(raw, targetPath(role));
    built.set(role, formatted);
  }
  return built;
}

function readIfExists(filePath: string): string | null {
  return safeExistsSync(filePath)
    ? String(safeReadFile(filePath, { encoding: 'utf8' }) || '')
    : null;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const shouldCheck = argv.includes('--check');
  const built = await buildGeneratedFiles();
  const rootDir = pathResolver.rootDir();

  if (shouldCheck) {
    const drifted: string[] = [];
    for (const [role, content] of built) {
      const filePath = targetPath(role);
      if (readIfExists(filePath) !== content) {
        drifted.push(path.relative(rootDir, filePath));
      }
    }
    if (drifted.length === 0) {
      console.log('subagent definitions are up to date');
      return;
    }
    console.error('subagent definition drift detected — run pnpm agents:generate');
    for (const rel of drifted) console.error(`- ${rel} differs`);
    process.exitCode = 1;
    return;
  }

  return withExecutionContext('generate_subagent_definitions', () => {
    for (const [role, content] of built) {
      const filePath = targetPath(role);
      safeWriteFile(filePath, content);
      console.log(`wrote ${path.relative(rootDir, filePath)}`);
    }
  });
}

if (process.argv[1] && /generate_subagent_definitions\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
