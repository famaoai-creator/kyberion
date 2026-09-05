/** PI-09: progressive disclosure for Agent-Skill markdown resources. */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import {
  appendPromptVisibilityRecord,
  type PromptVisibilityRecord,
} from './prompt-visibility-ledger.js';
import {
  type ResourceProvenance,
  type ResourceProvenanceScope,
  type ResourceTrust,
} from './resource-provenance.js';
import { isSkillAllowed } from './skill-plugin-loader.js';
import { assertScopeContext, type ScopeContext } from './scope-context.js';
import { requiresProjectTrust } from './trust-requiring-resources.js';
import type { ToolDefinition } from './reasoning-backend.js';
import {
  planDeferredToolLoading,
  type DeferredToolLoadingPlan,
} from './prompt-cache-discipline.js';

export interface SkillResourceFrontmatter {
  name: string;
  description: string;
  disable_model_invocation: boolean;
  allowed_tools: string[];
}

export interface SkillResourceDescriptor {
  name: string;
  description: string;
  path: string;
  frontmatter: SkillResourceFrontmatter;
  provenance: ResourceProvenance;
}

export type SkillReadOrigin = 'model' | 'explicit';

export interface ReadSkillResourceForModelInput {
  missionPath: string;
  missionId: string;
  taskId?: string;
  contextPackId?: string;
  scope: ScopeContext;
  /** Project-local skill bodies require an explicit trust decision at read time too. */
  trustResolved?: boolean;
}

export interface ReadSkillResourceForModelResult {
  body: string;
  promptVisibilityRecord: PromptVisibilityRecord;
}

export interface SkillToolSurfaceOptions {
  /** Role used by the same governed tool visibility contract as reasoning calls. */
  role?: string;
  /** Explicit stable-prefix tools; omitted means tool_search when available. */
  activeToolNames?: readonly string[];
}

function parseScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function parseAllowedTools(value: string): string[] {
  const normalized = parseScalar(value);
  if (!normalized) return [];
  const list =
    normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  return Array.from(
    new Set(
      list
        .split(',')
        .map((entry) => parseScalar(entry))
        .filter(Boolean)
    )
  );
}

function parseSkillDocument(raw: string, filePath: string): SkillResourceFrontmatter {
  if (!raw.startsWith('---\n')) {
    throw new Error(`[SKILL_RESOURCE_INVALID] missing frontmatter: ${filePath}`);
  }
  const end = raw.indexOf('\n---', 4);
  if (end < 0) throw new Error(`[SKILL_RESOURCE_INVALID] unterminated frontmatter: ${filePath}`);
  const values = new Map<string, string>();
  for (const line of raw.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = parseScalar(values.get('name') || '');
  const description = parseScalar(values.get('description') || '');
  if (!name || !description) {
    throw new Error(`[SKILL_RESOURCE_INVALID] name and description are required: ${filePath}`);
  }
  const disableRaw = parseScalar(
    values.get('disable-model-invocation') || values.get('disable_model_invocation') || 'false'
  );
  if (disableRaw !== 'true' && disableRaw !== 'false') {
    throw new Error(
      `[SKILL_RESOURCE_INVALID] disable-model-invocation must be boolean: ${filePath}`
    );
  }
  return {
    name,
    description,
    disable_model_invocation: disableRaw === 'true',
    allowed_tools: parseAllowedTools(
      values.get('allowed-tools') || values.get('allowed_tools') || ''
    ),
  };
}

function defaultProvenance(filePath: string): ResourceProvenance {
  const normalized = filePath.replaceAll('\\', '/');
  const scope: ResourceProvenanceScope = normalized.includes('/active/shared/')
    ? 'temporary'
    : normalized.includes('/knowledge/personal/')
      ? 'personal'
      : normalized.includes('/active/missions/')
        ? 'mission'
        : 'repository';
  const isPlugin = normalized.includes('/plugins/');
  const trust: ResourceTrust = isPlugin
    ? 'official'
    : scope === 'temporary'
      ? 'untrusted'
      : 'trusted';
  return {
    source: 'skill-resource-loader',
    scope,
    origin: isPlugin ? 'plugin' : scope === 'temporary' ? 'generated' : 'builtin',
    base_dir: path.dirname(filePath),
    trust,
  };
}

function resolveSkillPath(inputPath: string): string {
  const resolved = pathResolver.rootResolve(inputPath);
  if (path.extname(resolved).toLowerCase() === '.md') return resolved;
  return path.join(resolved, 'SKILL.md');
}

function assertSkillResourcePath(filePath: string): string {
  const root = path.resolve(pathResolver.rootDir());
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (
    !relative ||
    relative === '.' ||
    relative === '..' ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `[SKILL_RESOURCE_SCOPE] skill resource must be inside the repository root: ${filePath}`
    );
  }

  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (!safeExistsSync(current)) break;
    if (safeLstat(current).isSymbolicLink()) {
      throw new Error(
        `[SKILL_RESOURCE_SCOPE] skill resource cannot traverse a symbolic link: ${relative}`
      );
    }
  }
  return relative;
}

function assertSkillResourceTrust(relative: string, trustResolved?: boolean): void {
  if (trustResolved !== true && requiresProjectTrust(relative)) {
    throw new Error(
      `[TRUST_REQUIRED] project-local skill cannot be loaded before trust resolution: ${relative}`
    );
  }
}

/** Load only skill metadata; the body is intentionally not returned. */
export function loadSkillResourceDescriptor(
  inputPath: string,
  provenance?: Partial<ResourceProvenance>,
  options: { trustResolved?: boolean } = {}
): SkillResourceDescriptor {
  const filePath = resolveSkillPath(inputPath);
  const relative = assertSkillResourcePath(filePath);
  assertSkillResourceTrust(relative, options.trustResolved);
  if (!safeExistsSync(filePath)) throw new Error(`[SKILL_RESOURCE_NOT_FOUND] ${filePath}`);
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`[SKILL_RESOURCE_INVALID] skill resource must be a regular file: ${filePath}`);
  }
  const frontmatter = parseSkillDocument(
    String(safeReadFile(filePath, { encoding: 'utf8' }) || ''),
    filePath
  );
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    path: filePath,
    frontmatter,
    provenance: { ...defaultProvenance(filePath), ...provenance },
  };
}

/** Render the model-visible index without including skill bodies. */
export function renderSkillResourceIndex(descriptors: readonly SkillResourceDescriptor[]): string {
  const escape = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  return [...descriptors]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      (descriptor) =>
        `<skill name="${escape(descriptor.name)}" description="${escape(descriptor.description)}" />`
    )
    .join('\n');
}

/**
 * PI-17: project a skill's allowed-tools frontmatter onto the governed tool
 * catalog without widening the skill's authority. The default active set is
 * the read-only `tool_search` surface when the skill allows it; all other
 * allowed tools are deferred so the stable prompt prefix stays small. If the
 * skill does not allow tool_search, all role-visible allowed tools remain
 * active because there is no governed discovery path to promote them later.
 */
export function resolveSkillToolSurface(
  descriptor: SkillResourceDescriptor,
  catalog: readonly ToolDefinition[],
  options: SkillToolSurfaceOptions = {}
): DeferredToolLoadingPlan<ToolDefinition> {
  const allowed = new Set(
    descriptor.frontmatter.allowed_tools.map((name) => name.trim()).filter(Boolean)
  );
  if (allowed.size === 0) {
    return { active: [], deferred: [], announcement: null };
  }

  const catalogByName = new Map(catalog.map((tool) => [tool.name, tool]));
  for (const name of allowed) {
    if (!catalogByName.has(name)) {
      throw new Error(`[SKILL_TOOL_UNKNOWN] ${descriptor.name} allows unknown tool "${name}"`);
    }
  }

  const roleVisible = catalog.filter(
    (tool) =>
      allowed.has(tool.name) &&
      (!options.role || !tool.allowed_roles?.length || tool.allowed_roles.includes(options.role))
  );
  const roleVisibleNames = new Set(roleVisible.map((tool) => tool.name));
  const requestedActive = options.activeToolNames
    ? [...new Set(options.activeToolNames.map((name) => name.trim()).filter(Boolean))]
    : roleVisibleNames.has('tool_search')
      ? ['tool_search']
      : roleVisible.map((tool) => tool.name);

  for (const name of requestedActive) {
    if (!allowed.has(name) || !catalogByName.has(name)) {
      throw new Error(
        `[SKILL_TOOL_ACTIVE_NOT_ALLOWED] ${descriptor.name} cannot activate "${name}"`
      );
    }
    if (!roleVisibleNames.has(name)) {
      throw new Error(`[SKILL_TOOL_ROLE_DENIED] role "${options.role ?? ''}" cannot use "${name}"`);
    }
  }

  const activeNames = new Set(requestedActive);
  return planDeferredToolLoading(roleVisible, {
    ...(options.role ? { role: options.role } : {}),
    deferredToolNames: roleVisible
      .filter((tool) => !activeNames.has(tool.name))
      .map((tool) => tool.name),
  });
}

/** Read the full body only from an explicit caller, never from model index rendering. */
export function readSkillResourceBody(
  descriptor: SkillResourceDescriptor,
  origin: SkillReadOrigin = 'explicit',
  options: { trustResolved?: boolean } = {}
): string {
  const relative = assertSkillResourcePath(descriptor.path);
  assertSkillResourceTrust(relative, options.trustResolved);
  if (origin === 'model' && descriptor.frontmatter.disable_model_invocation) {
    throw new Error(`[SKILL_MODEL_INVOCATION_DISABLED] ${descriptor.name}`);
  }
  if (!safeExistsSync(descriptor.path)) {
    throw new Error(`[SKILL_RESOURCE_NOT_FOUND] ${descriptor.path}`);
  }
  if (!safeLstat(descriptor.path).isFile()) {
    throw new Error(
      `[SKILL_RESOURCE_INVALID] skill resource must be a regular file: ${descriptor.path}`
    );
  }
  return String(safeReadFile(descriptor.path, { encoding: 'utf8' }) || '')
    .replace(/^---\n[\s\S]*?\n---\n/u, '')
    .trim();
}

/**
 * PI-09: explicit `knowledge.read`-style model read. The caller must provide
 * mission scope; the body is returned only after a metadata-only visibility
 * receipt has been appended. No raw skill body is persisted.
 */
export function readSkillResourceForModel(
  descriptor: SkillResourceDescriptor,
  input: ReadSkillResourceForModelInput
): ReadSkillResourceForModelResult {
  const scope = assertScopeContext(input.scope, { requireMission: true });
  if (scope.mission_id !== input.missionId) {
    throw new Error(
      `[SKILL_SCOPE_MISMATCH] scope mission '${scope.mission_id}' does not match '${input.missionId}'`
    );
  }
  const decision = isSkillAllowed(descriptor.name, scope);
  if (!decision.allowed) {
    throw new Error(
      `[SKILL_RESOURCE_RESTRICTED] ${descriptor.name}: ${decision.reason || 'policy'}`
    );
  }
  const body = readSkillResourceBody(descriptor, 'model', {
    trustResolved: input.trustResolved,
  });
  const promptVisibilityRecord = appendPromptVisibilityRecord({
    missionPath: input.missionPath,
    missionId: input.missionId,
    source: 'skill-resource-loader',
    form: 'skill_body',
    content: body,
    ...(input.contextPackId ? { contextPackId: input.contextPackId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    knowledgeRefs: [descriptor.path],
  });
  return { body, promptVisibilityRecord };
}
