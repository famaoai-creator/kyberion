import * as path from 'node:path';
import type {
  ResourceAccessCustody,
  ResourceAccessOperation,
  ResourceAccessScope,
} from './resource-access-scope.js';
import type { WriteContent } from './customer-decision-record-content.js';
import { isValidTenantSlug } from './scope.js';
import { isRecord } from './text.js';

/**
 * Generic evaluator for `authority_role_permissions.<role>.narrow` declarations
 * in security-policy.json (G3): deny-only overlays that narrow what a role may
 * touch. The rule lives here in the gate so it takes effect even when no
 * store module is loaded; the role names live only in the policy data.
 *
 * Declaration kinds:
 *   - `deny`:            operations this role can never perform
 *   - `only`:            per-operation path allowlists ({path}|{prefix}|{pattern})
 *   - `content_check`:   named content checks for declared files
 *                        (`append_only_jsonl` + `id_field`)
 *   - `require_scope`:   a live ResourceAccessScope is required, optionally with
 *                        required fields (`fields`) or a read-only single-path
 *                        ceiling fingerprint (`exact`)
 *   - `structural_mkdir`: the role may attempt a shared structural mkdir under
 *                        the guard's shared checks (evaluated by the caller)
 *
 * Evaluation state is limited to security-policy (already read by the guard)
 * and the current resource access scope — a declaration that would need more
 * state is de-facto code and does not belong here.
 */

interface NarrowPathRule {
  path?: string;
  prefix?: string;
  pattern?: string;
}

interface NarrowContentCheck {
  path: string;
  kind: 'append_only_jsonl';
  id_field: string;
  refusal_prefix?: string;
}

interface NarrowRequireScope {
  /** Scope fields that must be present (e.g. 'organizationId'). */
  fields?: string[];
  /**
   * Custody kinds the bound scope may hold (G4). Absent means any custody is
   * fine; present requires the scope's normalized custody kind to be listed —
   * a scope with no explicit `custody` is tenant.
   */
  custody?: ResourceAccessCustody['kind'] | readonly ResourceAccessCustody['kind'][];
  /**
   * Read-only single-path ceiling fingerprint (a ceiling requirement):
   * exactly one `readExact` entry, no write/append/mkdir/metadata lists, no
   * organization/project binding. `read_path_pattern` additionally requires the
   * single read path to match a declared regex, and `read_path_tenant_group`
   * requires the named capture group of that regex to equal the scope's tenant.
   */
  exact?: {
    read_only?: boolean;
    read_path_pattern?: string;
    read_path_tenant_group?: number;
    allow_product_knowledge_read?: boolean;
  };
  reason?: string;
}

export interface RoleNarrowDeclaration {
  deny?: ResourceAccessOperation[];
  deny_reason?: string;
  only?: Partial<Record<ResourceAccessOperation, NarrowPathRule[]>>;
  only_reason?: string;
  content_check?: NarrowContentCheck[];
  require_scope?: NarrowRequireScope;
  structural_mkdir?: boolean;
}

const VALID_OPERATIONS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'append',
  'mkdir',
  'metadata',
]);

function roleRulesRecord(policy: unknown, role: string): Record<string, unknown> | undefined {
  if (!isRecord(policy)) return undefined;
  const permissions = policy.authority_role_permissions;
  if (!isRecord(permissions)) return undefined;
  const roleRules = permissions[role];
  return isRecord(roleRules) ? roleRules : undefined;
}

/** The role's `narrow` declaration, or undefined when absent/not an object. */
export function roleNarrowRules(policy: unknown, role: string): RoleNarrowDeclaration | undefined {
  const narrow = roleRulesRecord(policy, role)?.narrow;
  return isRecord(narrow) ? (narrow as RoleNarrowDeclaration) : undefined;
}

/** Does the role's declaration mark it as structural-mkdir capable? */
export function roleNarrowAllowsStructuralMkdir(
  policy: unknown,
  role: string | undefined
): boolean {
  if (!role) return false;
  const narrow = roleRulesRecord(policy, role)?.narrow;
  return narrow !== undefined && narrowDeclarationValid(narrow)
    ? (narrow as RoleNarrowDeclaration).structural_mkdir === true
    : false;
}

function pathRuleMatches(rule: NarrowPathRule, relativePath: string): boolean {
  if (typeof rule.path === 'string' && relativePath === rule.path) return true;
  if (typeof rule.prefix === 'string' && relativePath.startsWith(rule.prefix)) return true;
  if (typeof rule.pattern === 'string') {
    try {
      if (new RegExp(rule.pattern, 'u').test(relativePath)) return true;
    } catch {
      // An invalid declared pattern matches nothing (fail closed below).
    }
  }
  return false;
}

const nonEmptyLines = (text: string) => text.split('\n').filter((line) => line.trim().length > 0);

/**
 * append_only_jsonl: every existing line stays byte-identical and in place;
 * each new line is a JSON object carrying a new string id field. Returns the
 * refusal detail (without the prefix), or null.
 */
export function appendOnlyJsonlProblem(
  previous: string | undefined,
  next: string,
  idField: string
): string | null {
  const before = nonEmptyLines(previous ?? '');
  const after = nonEmptyLines(next);
  if (after.length < before.length || before.some((line, index) => after[index] !== line))
    return 'the writer may only append entries';
  const ids = new Set<string>();
  for (const line of before) {
    try {
      const id = (JSON.parse(line) as Record<string, unknown>)[idField];
      if (typeof id === 'string') ids.add(id);
    } catch {
      // An unreadable existing line stays as it is.
    }
  }
  for (const line of after.slice(before.length)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return 'a new entry is not JSON';
    }
    const id = isRecord(entry) && !Array.isArray(entry) ? entry[idField] : undefined;
    if (typeof id !== 'string') return `a new entry needs an ${idField}`;
    if (ids.has(id)) return `a new entry may not reuse an ${idField}`;
    ids.add(id);
  }
  return null;
}

/** Does the scope satisfy a declared `exact` ceiling fingerprint? */
function exactScopeMatches(
  scope: ResourceAccessScope,
  exact: NonNullable<NarrowRequireScope['exact']>
): boolean {
  if (exact.read_only === true) {
    if (
      scope.organizationId ||
      scope.projectId ||
      (scope.metadataExact?.length ?? 0) > 0 ||
      scope.readExact.length !== 1 ||
      scope.writeExact.length > 0 ||
      (scope.appendExact?.length ?? 0) > 0 ||
      scope.mkdirExact.length > 0
    )
      return false;
  }
  if (exact.read_path_pattern !== undefined) {
    const target = scope.readExact[0];
    let match: RegExpMatchArray | null = null;
    try {
      match =
        typeof target === 'string' ? target.match(new RegExp(exact.read_path_pattern, 'u')) : null;
    } catch {
      match = null;
    }
    if (!match) return false;
    if (
      exact.read_path_tenant_group !== undefined &&
      (!isValidTenantSlug(scope.tenantSlug ?? '') ||
        match[exact.read_path_tenant_group] !== scope.tenantSlug)
    )
      return false;
  }
  if (exact.allow_product_knowledge_read === true && scope.allowProductKnowledgeRead !== true)
    return false;
  return true;
}

/** Narrow declaration validation — a malformed declaration fails closed.
 * Mirrors `$defs.narrow_declaration` in security-policy.schema.json: an
 * 'append' key is always invalid (append is evaluated as `write`, so a
 * declared append rule could never take effect), a declared `only.<op>`
 * must restrict (an empty list would silently permit), and every declared
 * field is type-checked so malformed shapes deny as invalid instead of
 * falling through open.
 */
export function narrowDeclarationValid(narrow: unknown): boolean {
  if (!isRecord(narrow)) return false;
  if (
    (narrow.deny_reason !== undefined && typeof narrow.deny_reason !== 'string') ||
    (narrow.only_reason !== undefined && typeof narrow.only_reason !== 'string') ||
    (narrow.structural_mkdir !== undefined && typeof narrow.structural_mkdir !== 'boolean')
  )
    return false;
  if (narrow.deny !== undefined) {
    if (
      !Array.isArray(narrow.deny) ||
      narrow.deny.length === 0 ||
      narrow.deny.some(
        (op) => typeof op !== 'string' || !VALID_OPERATIONS.has(op) || op === 'append'
      )
    )
      return false;
  }
  if (narrow.only !== undefined) {
    if (!isRecord(narrow.only)) return false;
    for (const [op, rules] of Object.entries(narrow.only)) {
      if (!VALID_OPERATIONS.has(op) || op === 'append' || !Array.isArray(rules)) return false;
      if (rules.length === 0) return false;
      for (const rule of rules) {
        if (!isRecord(rule)) return false;
        if (rule.pattern === undefined && rule.path === undefined && rule.prefix === undefined)
          return false;
        for (const key of ['path', 'prefix', 'pattern'] as const)
          if (rule[key] !== undefined && typeof rule[key] !== 'string') return false;
        if (rule.pattern !== undefined) {
          try {
            new RegExp(String(rule.pattern), 'u');
          } catch {
            return false;
          }
        }
      }
    }
  }
  if (narrow.content_check !== undefined) {
    if (!Array.isArray(narrow.content_check) || narrow.content_check.length === 0) return false;
    for (const check of narrow.content_check) {
      if (!isRecord(check) || check.kind !== 'append_only_jsonl') return false;
      if (typeof check.path !== 'string' || typeof check.id_field !== 'string') return false;
      if (check.refusal_prefix !== undefined && typeof check.refusal_prefix !== 'string')
        return false;
    }
  }
  if (narrow.require_scope !== undefined) {
    if (!isRecord(narrow.require_scope)) return false;
    const scope = narrow.require_scope;
    if (scope.fields !== undefined) {
      if (!Array.isArray(scope.fields) || scope.fields.length === 0) return false;
      if (scope.fields.some((field) => typeof field !== 'string')) return false;
    }
    if (scope.custody !== undefined) {
      const kinds = Array.isArray(scope.custody) ? scope.custody : [scope.custody];
      if (
        kinds.length === 0 ||
        kinds.some(
          (kind) => typeof kind !== 'string' || !['system', 'tenant', 'person'].includes(kind)
        )
      )
        return false;
    }
    if (scope.reason !== undefined && typeof scope.reason !== 'string') return false;
    const exact = scope.exact;
    if (exact !== undefined) {
      if (!isRecord(exact)) return false;
      if (
        (exact.read_only !== undefined && typeof exact.read_only !== 'boolean') ||
        (exact.allow_product_knowledge_read !== undefined &&
          typeof exact.allow_product_knowledge_read !== 'boolean')
      )
        return false;
      if (exact.read_path_tenant_group !== undefined) {
        if (
          typeof exact.read_path_tenant_group !== 'number' ||
          !Number.isInteger(exact.read_path_tenant_group) ||
          exact.read_path_tenant_group < 1
        )
          return false;
      }
      if (exact.read_path_pattern !== undefined) {
        if (typeof exact.read_path_pattern !== 'string') return false;
        try {
          new RegExp(exact.read_path_pattern, 'u');
        } catch {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Evaluate the role's `narrow` declaration for this I/O. Returns the refusal
 * reason, or null. Order inside the declaration: `deny` → `require_scope` →
 * `only` → `content_check`. `append` retains every write restriction (it is
 * evaluated as `write`, same as the rules it replaced).
 */
export function roleNarrowingDenial(input: {
  policy: unknown;
  role: string | undefined;
  relativePath: string;
  operation: ResourceAccessOperation;
  scope: ResourceAccessScope | undefined;
  content: WriteContent | undefined;
  /** The guard's own raw read of a repo-relative file (undefined when absent). */
  readRepoFile: (repoRelative: string) => string | undefined;
}): string | null {
  const { role, relativePath } = input;
  if (!role) return null;
  const rawNarrow = roleRulesRecord(input.policy, role)?.narrow;
  if (rawNarrow === undefined) return null;
  if (!narrowDeclarationValid(rawNarrow))
    return `[ROLE_NARROWING_INVALID] role '${role}' has a malformed narrow declaration (security-policy.json authority_role_permissions.${role}.narrow)`;
  const rules = rawNarrow as RoleNarrowDeclaration;
  const operation = input.operation === 'append' ? 'write' : input.operation;

  if (Array.isArray(rules.deny) && rules.deny.includes(operation)) {
    return (
      rules.deny_reason ??
      `[ROLE_NARROWING_DENIED] role '${role}' is denied '${operation}' by its narrow declaration (security-policy.json authority_role_permissions.${role}.narrow.deny)`
    );
  }

  const require = rules.require_scope;
  if (require) {
    const scope = input.scope;
    const missingField = (require.fields ?? []).find(
      (field) => !scope?.[field as keyof ResourceAccessScope]
    );
    const custodyKinds = Array.isArray(require.custody)
      ? require.custody
      : require.custody === undefined
        ? []
        : [require.custody];
    const fails =
      !scope ||
      missingField !== undefined ||
      (custodyKinds.length > 0 && !custodyKinds.includes(scope.custody?.kind ?? 'tenant')) ||
      (require.exact !== undefined && !exactScopeMatches(scope, require.exact));
    if (fails) {
      return (
        require.reason ??
        `[RESOURCE_SCOPE_REQUIRED] role '${role}' requires a bound resource access capability for '${operation}'`
      );
    }
  }

  const only = rules.only?.[operation];
  if (Array.isArray(only) && only.length > 0) {
    const normalized =
      operation === 'read' ||
      operation === 'metadata' ||
      path.posix.normalize(relativePath) === relativePath;
    if (!normalized || !only.some((rule) => pathRuleMatches(rule, relativePath))) {
      return (
        rules.only_reason ??
        `[ROLE_NARROWING_DENIED] role '${role}' may not ${operation} '${relativePath}' outside its declared paths (security-policy.json authority_role_permissions.${role}.narrow.only)`
      );
    }
  }

  if (operation === 'write' && Array.isArray(rules.content_check)) {
    for (const check of rules.content_check) {
      if (check.path !== relativePath || check.kind !== 'append_only_jsonl') continue;
      const prefix = check.refusal_prefix ?? '[ROLE_NARROWING_CONTENT_REFUSED]';
      if (input.content === undefined)
        return `${prefix} writes only whole files whose content the guard checks`;
      let previous: string | undefined;
      try {
        previous = input.readRepoFile(relativePath);
      } catch {
        return `${prefix} the file on disk could not be read for the content check`;
      }
      const next =
        typeof input.content === 'string' ? input.content : input.content.toString('utf8');
      const problem = appendOnlyJsonlProblem(previous, next, check.id_field);
      if (problem) return `${prefix} ${problem}`;
    }
  }
  return null;
}
