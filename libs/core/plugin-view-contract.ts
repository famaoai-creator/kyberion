/**
 * EP-05: plugin-contributed declarative views.
 *
 * A plugin may declare `provides.views`: A2UI documents rendered with the
 * shared `kyberion-base` catalog. Views are data — nothing in a view is ever
 * evaluated as code — so this module only validates and serves them:
 *
 *   - the declaration is schema-validated
 *     (knowledge/product/schemas/plugin-view-declaration.schema.json);
 *   - the document is a list of A2UI messages validated against the A2UI
 *     message schema and `validateA2UIMessage` (catalog props), with
 *     catalogId `kyberion-base`, component types restricted to a
 *     display-only subset of the catalog, no HTML/script-capable props or
 *     navigation targets, and every `*Key` present in the vocabulary;
 *   - `sandboxed-iframe` isolation is reserved (`[PLUGIN_VIEW_UNSUPPORTED]`)
 *     and every requested capability is denied (the allowlist is empty);
 *   - every action targets one of the plugin's own `provides.ops`, declares
 *     a closed params schema (`additionalProperties:false` on every object)
 *     and is the only thing a document may reference as an action.
 *
 * Managed plugins are served only while `activatable` (which re-verifies the
 * approved content digest on every read); documents of any other record are
 * never read. Viewer role / tier / tenant gating is evaluated server-side by
 * `isPluginViewVisible`; a client filter can only narrow it.
 */
import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import { compileSchema, createAjv2020 } from './foundation/ajv.js';
import { isRecord } from './foundation/text.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { readJson } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat } from './secure-io.js';
import { validateA2UIMessage, type A2UIComponent, type A2UIMessage } from './a2ui.js';
import { A2UI_BASE_CATALOG_ID, type KyberionBaseComponentType } from './a2ui-catalog.js';
import { resolveVocabularyEntry } from './vocabulary-catalog.js';
import { isPathContainedIn } from './plugin-source-trust.js';
import {
  isManagedPluginActivationAllowed,
  type ManagedPluginRecord,
} from './plugin-managed-install.js';
import type { PluginPermissionGrant } from './plugin-permissions.js';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  listApprovalRequests,
} from './approval-store.js';
import { resolveActuatorOperation } from './actuator-op-registry.js';
import { runOpPreflight } from './op-preflight.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PluginViewIsolation = 'in-process-a2ui' | 'sandboxed-iframe';
export type PluginViewRole = 'readonly' | 'localadmin';
export type PluginViewTier = 'public' | 'confidential' | 'personal';
export type PluginViewActionAuthority = 'agent' | 'human';

export interface PluginViewAction {
  id: string;
  authority: PluginViewActionAuthority;
  op: string;
  paramsSchema: Record<string, unknown>;
}

export interface PluginViewDeclaration {
  id: string;
  titleKey: string;
  document: string;
  isolation: PluginViewIsolation;
  capabilities: string[];
  roleGate: { minRole: PluginViewRole; tiers: PluginViewTier[] };
  actions: PluginViewAction[];
  lifecycle: { refresh: 'static' | 'on_open' };
}

export type PluginViewErrorCode =
  | 'PLUGIN_VIEW_INVALID'
  | 'PLUGIN_VIEW_UNSUPPORTED'
  | 'PLUGIN_VIEW_CAPABILITY_DENIED'
  | 'PLUGIN_VIEW_ACTION_DENIED'
  | 'PLUGIN_VIEW_DENIED'
  | 'PLUGIN_VIEW_NOT_FOUND'
  | 'PLUGIN_VIEW_PARAMS_INVALID'
  | 'PLUGIN_VIEW_ACTION_UNAVAILABLE';

export class PluginViewError extends Error {
  constructor(
    public readonly code: PluginViewErrorCode,
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = 'PluginViewError';
  }
}

/** HTTP status a surface should answer for a view error. */
export function pluginViewErrorStatus(code: PluginViewErrorCode): number {
  switch (code) {
    case 'PLUGIN_VIEW_NOT_FOUND':
      return 404;
    case 'PLUGIN_VIEW_ACTION_DENIED':
    case 'PLUGIN_VIEW_DENIED':
    case 'PLUGIN_VIEW_CAPABILITY_DENIED':
      return 403;
    case 'PLUGIN_VIEW_PARAMS_INVALID':
      return 400;
    case 'PLUGIN_VIEW_ACTION_UNAVAILABLE':
      return 409;
    default:
      return 422;
  }
}

export interface ValidatePluginViewContext {
  /** The plugin's own `provides.ops`. */
  providedOps: readonly string[];
  /**
   * The approved grant. Actions may only target the plugin's own ops (which
   * never need `ops_invoke`); cross-plugin action ops are denied regardless
   * of the grant, so this is carried for diagnostics only.
   */
  grant?: PluginPermissionGrant | null;
  /** Vocabulary lookup; defaults to the shared user-facing vocabulary. */
  vocabularyHas?: (key: string) => boolean;
}

export interface LoadedPluginView {
  pluginId: string;
  declaration: PluginViewDeclaration;
  messages: A2UIMessage[];
  providedOps: string[];
  contentDigest?: string;
  /** Tenant the managed install was narrowed against (absent = shared). */
  tenantSlug?: string;
}

export interface PluginViewLoadError {
  pluginId: string;
  viewId?: string;
  code: PluginViewErrorCode;
  message: string;
}

export interface PluginViewLoadResult {
  pluginId: string;
  views: LoadedPluginView[];
  errors: PluginViewLoadError[];
}

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Capabilities a view may request. Deny by default: nothing is allowlisted
 * until a capability has a reviewed host implementation.
 */
export const PLUGIN_VIEW_CAPABILITY_ALLOWLIST: readonly string[] = Object.freeze([]);

/**
 * Display-only subset of the `kyberion-base` catalog. Host chrome (app shell,
 * nav rail, display controls), input/capture components (forms, secrets,
 * files, camera, voice, sketch) and modal/toolbar components are excluded —
 * they would need a capability this contract does not grant.
 */
export const PLUGIN_VIEW_COMPONENT_TYPES: readonly KyberionBaseComponentType[] = Object.freeze([
  'ui:page-header',
  'ui:tabs',
  'ui:stack',
  'ui:grid',
  'ui:section',
  'ui:next-action',
  'ui:metric',
  'ui:kv',
  'ui:table',
  'ui:list',
  'ui:text',
  'ui:code',
  'ui:status-pill',
  'ui:badge',
  'ui:callout',
  'ui:empty-state',
  'ui:skeleton',
  'ui:button',
  'ui:disclosure',
  'ui:settings-group',
  'ui:setting-row',
  'ui:bar-chart',
  'ui:line-chart',
  'ui:donut',
  'ui:sparkline',
  'ui:heatmap',
  'ui:meter',
  'ui:sequence',
  'ui:flow',
  'ui:stat-list',
]);

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_COMPONENTS = 400;
const MAX_COMPONENT_ID_LENGTH = 64;
const MAX_WALK_DEPTH = 32;

const FORBIDDEN_PROP_KEYS = new Set([
  'html',
  'innerhtml',
  'outerhtml',
  'dangerouslysetinnerhtml',
  'srcdoc',
  'src',
  'script',
  'style',
  'href',
]);
const EVENT_HANDLER_KEY = /^on[A-Z]/u;
const MARKUP_PATTERN =
  /<\s*\/?\s*(script|iframe|object|embed|style|link|meta|img|svg|a|form|base|frame)\b/iu;
const SCRIPT_URL_PATTERN = /(javascript|vbscript)\s*:|data\s*:\s*text\/html/iu;

const ROLE_RANK: Record<PluginViewRole, number> = { readonly: 0, localadmin: 1 };

// ---------------------------------------------------------------------------
// Schema validators (lazy)
// ---------------------------------------------------------------------------

let declarationValidator: ValidateFunction | null = null;
let messageValidator: ValidateFunction | null = null;

function declarationSchemaValidator(): ValidateFunction {
  declarationValidator ??= compileSchema(
    pathResolver.knowledge('product/schemas/plugin-view-declaration.schema.json'),
    createAjv2020()
  );
  return declarationValidator;
}

function a2uiMessageValidator(): ValidateFunction {
  // The message schema's legacy `$schema` URI is not a registered meta
  // schema; compile it the same way check_contract_schemas does.
  messageValidator ??= compileSchema(
    pathResolver.knowledge('product/schemas/a2ui-message.schema.json'),
    createAjv2020({ validateSchema: false })
  );
  return messageValidator;
}

function ajvErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function invalid(message: string): PluginViewError {
  return new PluginViewError('PLUGIN_VIEW_INVALID', message);
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

/** Schema-validates one `provides.views` entry and fills the defaults. */
export function parsePluginViewDeclaration(raw: unknown): PluginViewDeclaration {
  const validate = declarationSchemaValidator();
  if (!validate(raw)) throw invalid(`view declaration is invalid: ${ajvErrors(validate)}`);
  const value = raw as Record<string, unknown> & Partial<PluginViewDeclaration>;
  return {
    id: value.id as string,
    titleKey: value.titleKey as string,
    document: value.document as string,
    isolation: value.isolation as PluginViewIsolation,
    capabilities: [...(value.capabilities ?? [])],
    roleGate: {
      minRole: value.roleGate!.minRole,
      tiers: [...value.roleGate!.tiers],
    },
    actions: (value.actions ?? []).map((action) => ({ ...action })),
    lifecycle: { refresh: value.lifecycle?.refresh ?? 'static' },
  };
}

function assertClosedParamsSchema(schema: unknown, at: string, depth = 0): void {
  if (depth > MAX_WALK_DEPTH) throw invalid(`paramsSchema is nested too deeply at ${at}`);
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => assertClosedParamsSchema(entry, `${at}/${index}`, depth + 1));
    return;
  }
  if (!isRecord(schema)) return;
  const isObjectSchema =
    schema.type === 'object' ||
    (Array.isArray(schema.type) && schema.type.includes('object')) ||
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties);
  if (isObjectSchema && schema.additionalProperties !== false) {
    throw invalid(`paramsSchema object at ${at} must set additionalProperties:false`);
  }
  if (typeof schema.$ref === 'string' && !schema.$ref.startsWith('#')) {
    throw invalid(`paramsSchema at ${at} may not reference external schemas`);
  }
  for (const [key, nested] of Object.entries(schema)) {
    if (key === 'enum' || key === 'const' || key === 'default' || key === 'examples') continue;
    assertClosedParamsSchema(nested, `${at}/${key}`, depth + 1);
  }
}

function compileParamsSchema(schema: Record<string, unknown>, at: string): ValidateFunction {
  if (schema.type !== 'object') throw invalid(`paramsSchema at ${at} must be type:object`);
  assertClosedParamsSchema(schema, at);
  try {
    return createAjv2020().compile(schema);
  } catch (error) {
    throw invalid(
      `paramsSchema at ${at} does not compile: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

function defaultVocabularyHas(key: string): boolean {
  try {
    return resolveVocabularyEntry(key) !== null;
  } catch {
    return false; // ambiguous bare keys are not acceptable in a plugin view
  }
}

function actionRefId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.id === 'string') return value.id;
  return undefined;
}

function isActionKey(key: string): boolean {
  return key === 'action' || key.endsWith('_action') || key.endsWith('Action');
}

interface WalkState {
  actionIds: Set<string>;
  vocabularyHas: (key: string) => boolean;
}

function walkValue(value: unknown, at: string, state: WalkState, depth: number): void {
  if (depth > MAX_WALK_DEPTH) throw invalid(`document is nested too deeply at ${at}`);
  if (typeof value === 'string') {
    if (MARKUP_PATTERN.test(value) || SCRIPT_URL_PATTERN.test(value)) {
      throw invalid(`markup or script URL is not allowed in a plugin view (${at})`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkValue(entry, `${at}/${index}`, state, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const where = `${at}/${key}`;
    if (FORBIDDEN_PROP_KEYS.has(key.toLowerCase()) || EVENT_HANDLER_KEY.test(key)) {
      throw invalid(`prop '${key}' is not allowed in a plugin view (${where})`);
    }
    if (key.length > 3 && key.endsWith('Key')) {
      if (typeof nested !== 'string' || !state.vocabularyHas(nested)) {
        throw invalid(`vocabulary key ${JSON.stringify(nested)} at ${where} does not exist`);
      }
      continue;
    }
    if (isActionKey(key)) {
      const id = actionRefId(nested);
      if (id === undefined || !state.actionIds.has(id)) {
        throw invalid(
          `action ${JSON.stringify(id ?? nested)} at ${where} is not a declared action`
        );
      }
    }
    walkValue(nested, where, state, depth + 1);
  }
}

function normalizeMessages(document: unknown): unknown[] {
  if (Array.isArray(document)) return document;
  if (isRecord(document)) return [document];
  throw invalid('document must be an A2UI message or an array of A2UI messages');
}

function validateDocument(
  declaration: PluginViewDeclaration,
  document: unknown,
  vocabularyHas: (key: string) => boolean
): A2UIMessage[] {
  const raw = normalizeMessages(document);
  if (raw.length === 0) throw invalid('document has no messages');
  const schema = a2uiMessageValidator();
  const messages: A2UIMessage[] = raw.map((entry, index) => {
    if (!schema(entry)) throw invalid(`message ${index}: ${ajvErrors(schema)}`);
    try {
      return validateA2UIMessage(entry);
    } catch (error) {
      throw invalid(`message ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const create = messages[0].createSurface;
  if (!create) throw invalid('the first message must be createSurface');
  if (create.catalogId !== A2UI_BASE_CATALOG_ID) {
    throw invalid(`catalogId must be '${A2UI_BASE_CATALOG_ID}' (got '${create.catalogId}')`);
  }
  const surfaceId = create.surfaceId;
  const componentIds = new Set<string>();
  const components: A2UIComponent[] = [];
  let hasComponents = false;
  messages.forEach((message, index) => {
    if (message.deleteSurface) throw invalid(`message ${index}: deleteSurface is not allowed`);
    if (index > 0 && message.createSurface) {
      throw invalid(`message ${index}: only one createSurface is allowed`);
    }
    const payload =
      message.createSurface ?? message.updateComponents ?? message.updateDataModel ?? null;
    if (!payload || payload.surfaceId !== surfaceId) {
      throw invalid(`message ${index}: surfaceId must be '${surfaceId}'`);
    }
    for (const component of message.updateComponents?.components ?? []) {
      hasComponents = true;
      if (!(PLUGIN_VIEW_COMPONENT_TYPES as readonly string[]).includes(component.type)) {
        throw invalid(`component type '${component.type}' is not allowed in a plugin view`);
      }
      if (component.id.length > MAX_COMPONENT_ID_LENGTH) {
        throw invalid(`component id '${component.id}' exceeds ${MAX_COMPONENT_ID_LENGTH} chars`);
      }
      if (componentIds.has(component.id)) {
        throw invalid(`duplicate component id '${component.id}'`);
      }
      componentIds.add(component.id);
      components.push(component);
    }
  });
  if (!hasComponents) throw invalid('document declares no components');
  if (components.length > MAX_COMPONENTS) {
    throw invalid(`document declares more than ${MAX_COMPONENTS} components`);
  }
  for (const component of components) {
    for (const child of component.children ?? []) {
      if (!componentIds.has(child)) {
        throw invalid(`component '${component.id}' references unknown child '${child}'`);
      }
    }
  }
  walkValue(
    messages,
    '',
    {
      actionIds: new Set(declaration.actions.map((action) => action.id)),
      vocabularyHas,
    },
    0
  );
  return messages;
}

/**
 * Validates a parsed declaration and its document. Throws `PluginViewError`
 * (`[PLUGIN_VIEW_*]`); returns the validated A2UI messages.
 */
export function validatePluginView(
  declaration: PluginViewDeclaration,
  document: unknown,
  context: ValidatePluginViewContext
): A2UIMessage[] {
  const decl = parsePluginViewDeclaration(declaration);
  if (decl.isolation === 'sandboxed-iframe') {
    throw new PluginViewError(
      'PLUGIN_VIEW_UNSUPPORTED',
      `view '${decl.id}': sandboxed-iframe isolation is not supported yet`
    );
  }
  const deniedCapability = decl.capabilities.find(
    (capability) => !PLUGIN_VIEW_CAPABILITY_ALLOWLIST.includes(capability)
  );
  if (deniedCapability) {
    throw new PluginViewError(
      'PLUGIN_VIEW_CAPABILITY_DENIED',
      `view '${decl.id}' requests capability '${deniedCapability}', which is not granted to plugin views`
    );
  }
  const vocabularyHas = context.vocabularyHas ?? defaultVocabularyHas;
  if (!vocabularyHas(decl.titleKey)) {
    throw invalid(
      `view '${decl.id}': titleKey '${decl.titleKey}' does not exist in the vocabulary`
    );
  }
  const ownOps = new Set(context.providedOps);
  const actionIds = new Set<string>();
  for (const action of decl.actions) {
    if (actionIds.has(action.id))
      throw invalid(`view '${decl.id}': duplicate action '${action.id}'`);
    actionIds.add(action.id);
    if (!ownOps.has(action.op)) {
      throw new PluginViewError(
        'PLUGIN_VIEW_ACTION_DENIED',
        `view '${decl.id}' action '${action.id}' targets op '${action.op}', which the plugin does not provide`
      );
    }
    compileParamsSchema(action.paramsSchema, `${decl.id}/${action.id}`);
  }
  return validateDocument(decl, document, vocabularyHas);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((s) => s.trim())
    : [];
}

function readViewDocument(pluginRoot: string, relative: string): unknown {
  const normalized = relative.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw invalid(`document path '${relative}' is not a plain views/ path`);
  }
  const root = path.resolve(pluginRoot);
  const target = path.resolve(root, normalized);
  if (!isPathContainedIn(root, target) || target === root) {
    throw invalid(`document path '${relative}' escapes the plugin root`);
  }
  // Every segment below the root must be a real directory / regular file.
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (!safeExistsSync(cursor)) throw invalid(`document '${relative}' does not exist`);
    const stat = safeLstat(cursor);
    if (stat.isSymbolicLink()) throw invalid(`document path '${relative}' contains a symlink`);
    if (cursor === target ? !stat.isFile() : !stat.isDirectory()) {
      throw invalid(`document path '${relative}' is not a regular file`);
    }
    if (cursor === target && stat.size > MAX_DOCUMENT_BYTES) {
      throw invalid(`document '${relative}' exceeds ${MAX_DOCUMENT_BYTES} bytes`);
    }
  }
  try {
    // Wrapping lets the recursive dangerous-key check cover array documents too.
    return parseSafeJsonObjectValue(
      { document: readJson<unknown>(target) },
      `plugin view document ${relative}`
    ).document;
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

function readRootManifest(pluginRoot: string): Record<string, unknown> {
  for (const candidate of ['plugin-manifest.json', 'plugin.json']) {
    const manifestPath = path.join(pluginRoot, candidate);
    if (!safeExistsSync(manifestPath)) continue;
    const stat = safeLstat(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw invalid(`manifest must be a regular file: ${manifestPath}`);
    }
    try {
      return parseSafeJsonObjectValue(
        readJson<unknown>(manifestPath),
        `plugin manifest ${manifestPath}`
      );
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  }
  throw invalid(`no plugin manifest in ${pluginRoot}`);
}

export interface LoadPluginViewsOptions {
  vocabularyHas?: (key: string) => boolean;
}

/**
 * Loads and validates every `provides.views` entry of one plugin. A managed
 * record must be `activatable` (digest re-verified by the managed-install
 * read); otherwise `[PLUGIN_VIEW_DENIED]` is thrown before any document is
 * read. A plain directory is for official/in-repo plugins and tests. One
 * invalid view never hides the others: it is reported in `errors`.
 */
export function loadPluginViews(
  source: ManagedPluginRecord | string,
  options: LoadPluginViewsOptions = {}
): PluginViewLoadResult {
  let pluginRoot: string;
  let manifest: Record<string, unknown>;
  let pluginId: string;
  let grant: PluginPermissionGrant | null | undefined;
  let contentDigest: string | undefined;
  let tenantSlug: string | undefined;
  if (typeof source === 'string') {
    pluginRoot = path.resolve(source);
    manifest = readRootManifest(pluginRoot);
    pluginId =
      (typeof manifest.plugin_id === 'string' && manifest.plugin_id) ||
      (typeof manifest.name === 'string' && manifest.name) ||
      path.basename(pluginRoot);
  } else {
    if (!isManagedPluginActivationAllowed(source) || !source.manifest) {
      throw new PluginViewError(
        'PLUGIN_VIEW_DENIED',
        `plugin '${source.pluginId}' is not activatable (status=${source.activationStatus})`
      );
    }
    pluginRoot = source.managedPath;
    manifest = source.manifest.raw;
    pluginId = source.pluginId;
    grant = source.grantedPermissions ?? null;
    contentDigest = source.contentDigest;
    tenantSlug = source.tenantSlug;
  }

  const provides = isRecord(manifest.provides) ? manifest.provides : {};
  const providedOps = stringList(provides.ops);
  const result: PluginViewLoadResult = { pluginId, views: [], errors: [] };
  if (provides.views === undefined) return result;
  if (!Array.isArray(provides.views)) {
    result.errors.push({
      pluginId,
      code: 'PLUGIN_VIEW_INVALID',
      message: '[PLUGIN_VIEW_INVALID] provides.views must be an array',
    });
    return result;
  }
  const seen = new Set<string>();
  for (const entry of provides.views) {
    const viewId = isRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined;
    try {
      const declaration = parsePluginViewDeclaration(entry);
      if (seen.has(declaration.id)) throw invalid(`duplicate view id '${declaration.id}'`);
      seen.add(declaration.id);
      const document = readViewDocument(pluginRoot, declaration.document);
      const messages = validatePluginView(declaration, document, {
        providedOps,
        grant,
        vocabularyHas: options.vocabularyHas,
      });
      result.views.push({
        pluginId,
        declaration,
        messages,
        providedOps,
        ...(contentDigest ? { contentDigest } : {}),
        ...(tenantSlug ? { tenantSlug } : {}),
      });
    } catch (error) {
      const code = error instanceof PluginViewError ? error.code : 'PLUGIN_VIEW_INVALID';
      result.errors.push({
        pluginId,
        ...(viewId ? { viewId } : {}),
        code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Viewer gating
// ---------------------------------------------------------------------------

export interface PluginViewViewer {
  role: PluginViewRole;
  tierAccess: readonly string[];
  tenantSlugs: readonly string[] | 'all';
}

/** Client-supplied narrowing; never widens the viewer. */
export interface PluginViewFilter {
  tier?: string;
  tenant?: string;
}

export function isPluginViewVisible(
  view: Pick<LoadedPluginView, 'declaration' | 'tenantSlug'>,
  viewer: PluginViewViewer,
  filter: PluginViewFilter = {}
): boolean {
  if (ROLE_RANK[viewer.role] === undefined) return false;
  if (ROLE_RANK[viewer.role] < ROLE_RANK[view.declaration.roleGate.minRole]) return false;
  const tiers = filter.tier
    ? viewer.tierAccess.filter((tier) => tier === filter.tier)
    : viewer.tierAccess;
  if (!view.declaration.roleGate.tiers.every((tier) => tiers.includes(tier))) return false;
  if (view.tenantSlug) {
    if (viewer.tenantSlugs !== 'all' && !viewer.tenantSlugs.includes(view.tenantSlug)) {
      return false;
    }
    if (filter.tenant && filter.tenant !== view.tenantSlug) return false;
  }
  return true;
}

/**
 * Lists the views of every activatable managed plugin visible to `viewer`.
 * Non-activatable records (pending approval, digest mismatch, broken
 * manifest) are skipped without reading any of their files.
 */
export function listPluginViewsForViewer(
  records: readonly ManagedPluginRecord[],
  viewer: PluginViewViewer,
  filter: PluginViewFilter = {},
  options: LoadPluginViewsOptions = {}
): { views: LoadedPluginView[]; errors: PluginViewLoadError[] } {
  const views: LoadedPluginView[] = [];
  const errors: PluginViewLoadError[] = [];
  for (const record of records) {
    if (!isManagedPluginActivationAllowed(record)) continue;
    if (
      record.tenantSlug &&
      viewer.tenantSlugs !== 'all' &&
      !viewer.tenantSlugs.includes(record.tenantSlug)
    ) {
      continue; // never read another tenant's plugin files
    }
    const loaded = loadPluginViews(record, options);
    views.push(...loaded.views.filter((view) => isPluginViewVisible(view, viewer, filter)));
    errors.push(...loaded.errors);
  }
  views.sort((a, b) =>
    a.pluginId === b.pluginId
      ? a.declaration.id < b.declaration.id
        ? -1
        : 1
      : a.pluginId < b.pluginId
        ? -1
        : 1
  );
  return { views, errors };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ResolvedPluginViewAction {
  view: LoadedPluginView;
  action: PluginViewAction;
  params: Record<string, unknown>;
}

/**
 * Resolves an action request against a visible view: unknown action =>
 * NOT_FOUND, op not provided by the plugin => ACTION_DENIED, params that
 * fail the declared schema => PARAMS_INVALID.
 */
export function resolvePluginViewAction(
  view: LoadedPluginView,
  actionId: string,
  params: unknown
): ResolvedPluginViewAction {
  const action = view.declaration.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new PluginViewError(
      'PLUGIN_VIEW_NOT_FOUND',
      `view '${view.pluginId}/${view.declaration.id}' has no action '${actionId}'`
    );
  }
  if (!view.providedOps.includes(action.op)) {
    throw new PluginViewError(
      'PLUGIN_VIEW_ACTION_DENIED',
      `op '${action.op}' is not provided by plugin '${view.pluginId}'`
    );
  }
  const validate = compileParamsSchema(action.paramsSchema, `${view.declaration.id}/${action.id}`);
  const value = params === undefined ? {} : params;
  if (!isRecord(value) || !validate(value)) {
    throw new PluginViewError(
      'PLUGIN_VIEW_PARAMS_INVALID',
      `params for action '${actionId}' are invalid: ${isRecord(value) ? ajvErrors(validate) : 'must be an object'}`
    );
  }
  return { view, action, params: value };
}

export type PluginViewActionOutcome =
  | { status: 'approval_required'; approvalRequestId: string }
  | { status: 'dispatched'; handled: boolean };

export interface DispatchPluginViewActionContext {
  requestedBy: string;
  actorRole: string;
  surface: 'chronos' | 'api';
}

/** Chronos approval channel (listed by the Chronos approvals queue). */
export const PLUGIN_VIEW_APPROVAL_CHANNEL = 'chronos';

/**
 * `human` actions become a human-only approval request in the shared approval
 * store (the existing approval UI path); `agent` actions are dispatched only
 * when the owning plugin is active in this process and op preflight admits
 * the call. Nothing here imports or activates plugin code.
 */
export async function dispatchPluginViewAction(
  resolved: ResolvedPluginViewAction,
  context: DispatchPluginViewActionContext
): Promise<PluginViewActionOutcome> {
  const { view, action, params } = resolved;
  const target = `${view.pluginId}/${view.declaration.id}/${action.id}`;
  if (action.authority === 'human') {
    const payloadHash = computeApprovalPayloadHash({
      plugin_id: view.pluginId,
      content_digest: view.contentDigest ?? null,
      view_id: view.declaration.id,
      action_id: action.id,
      op: action.op,
      params,
    });
    const effectBinding = `plugin-view-action:${target}`;
    const existing = listApprovalRequests({
      storageChannels: [PLUGIN_VIEW_APPROVAL_CHANNEL],
      status: 'pending',
    }).find(
      (request) =>
        request.accountability?.payloadHash === payloadHash &&
        request.accountability?.effectBinding === effectBinding
    );
    if (existing) return { status: 'approval_required', approvalRequestId: existing.id };
    // Same authority the plugin subsystem uses for install approvals
    // (plugin-managed-install.ts): the request is a governed artifact of the
    // plugin subsystem; the viewer was authorized by the calling surface.
    const record = createApprovalRequest('mission_controller', {
      channel: PLUGIN_VIEW_APPROVAL_CHANNEL,
      storageChannel: PLUGIN_VIEW_APPROVAL_CHANNEL,
      threadTs: target,
      correlationId: `${target}:${payloadHash.slice(0, 16)}`,
      requestedBy: context.requestedBy,
      draft: {
        title: `Plugin view action: ${action.op}`,
        summary: `Plugin '${view.pluginId}' view '${view.declaration.id}' requests '${action.op}'.`,
        details: `Params: ${JSON.stringify(params)}`,
        severity: 'medium',
      },
      requestedByContext: {
        surface: context.surface,
        actorId: context.requestedBy,
        actorRole: context.actorRole,
      },
      justification: {
        reason: 'The plugin declared this view action with authority:human.',
        requestedEffects: [effectBinding],
      },
      accountability: { finalDecision: 'human_only', payloadHash, effectBinding },
    });
    return { status: 'approval_required', approvalRequestId: record.id };
  }

  const [domain, ...rest] = action.op.split(':');
  let operation: ReturnType<typeof resolveActuatorOperation> = null;
  try {
    operation = resolveActuatorOperation(domain, rest.join(':'));
  } catch {
    operation = null; // unknown op: the plugin is not active here
  }
  if (
    !operation?.handler ||
    operation.source !== 'plugin' ||
    operation.pluginId !== view.pluginId
  ) {
    throw new PluginViewError(
      'PLUGIN_VIEW_ACTION_UNAVAILABLE',
      `op '${action.op}' is not active for plugin '${view.pluginId}' in this process`
    );
  }
  const preflight = await runOpPreflight({ op: action.op, params, source: 'pipeline' });
  if (preflight.decision !== 'allow') {
    throw new PluginViewError(
      'PLUGIN_VIEW_ACTION_DENIED',
      `op preflight ${preflight.decision}: ${preflight.reason ?? action.op}`
    );
  }
  const input = preflight.repaired_input ?? params;
  const outcome = await operation.handler(operation.action, input, {}, operation.stepType);
  return { status: 'dispatched', handled: outcome.handled };
}

// ---------------------------------------------------------------------------
// Composition for a single A2UI surface
// ---------------------------------------------------------------------------

/**
 * Composes the visible views into one `updateComponents` payload: one
 * `ui:section` per view (title resolved by `resolveTitle`) wrapping that
 * view's root components. Component ids are prefixed per view so views can
 * never collide or reference each other's components.
 */
export function composePluginViewsA2UI(
  views: readonly LoadedPluginView[],
  resolveTitle: (titleKey: string) => string,
  surfaceId = 'chronos.headless.plugin-views'
): { updateComponents: { surfaceId: string; components: A2UIComponent[] } } {
  const components: A2UIComponent[] = [];
  views.forEach((view, index) => {
    const prefix = `pv${index}-`;
    const own = view.messages.flatMap((message) => message.updateComponents?.components ?? []);
    const childIds = new Set(own.flatMap((component) => component.children ?? []));
    const sectionId = `${prefix}section`;
    components.push({
      id: sectionId,
      type: 'ui:section',
      props: { title: resolveTitle(view.declaration.titleKey) },
      children: own.filter((c) => !childIds.has(c.id)).map((c) => `${prefix}${c.id}`),
    });
    for (const component of own) {
      components.push({
        ...component,
        id: `${prefix}${component.id}`,
        ...(component.children
          ? { children: component.children.map((child) => `${prefix}${child}`) }
          : {}),
      });
    }
  });
  return { updateComponents: { surfaceId, components } };
}

/** Test-only: drop cached schema validators. */
export function resetPluginViewContractForTests(): void {
  declarationValidator = null;
  messageValidator = null;
}
