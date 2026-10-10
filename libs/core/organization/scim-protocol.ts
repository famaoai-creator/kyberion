/**
 * SCIM 2.0 (RFC 7643 / RFC 7644) protocol pieces for the Users endpoint:
 * message schemas, the error envelope, the `filter` subset, paging, the
 * core User attribute subset Kyberion keeps, and PatchOp application.
 *
 * Pure functions only — no I/O. The provisioning operations live in
 * `scim-users.ts`, the credential in `scim-token-registry.ts`.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_SERVICE_PROVIDER_CONFIG_SCHEMA =
  'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
export const SCIM_RESOURCE_TYPE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
export const SCIM_SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';
export const SCIM_CONTENT_TYPE = 'application/scim+json';
export const SCIM_MAX_RESULTS = 200;
export const SCIM_DEFAULT_COUNT = 100;

/** Prefix of a SCIM provisioning token: `kscim~<tenant>~<token_id>~<secret>`. */
export const SCIM_TOKEN_PREFIX = 'kscim~';

/**
 * True when a bearer credential has the SCIM provisioning token shape. Other
 * surfaces reject such a credential outright: a provisioning token reaches
 * only its own tenant's SCIM endpoint, never a member or admin API.
 */
export function isScimProvisioningTokenFormat(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.trim().startsWith(SCIM_TOKEN_PREFIX);
}

export type ScimErrorType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue'
  | 'invalidVers'
  | 'sensitive';

export type ScimStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 501;

export class ScimError extends Error {
  constructor(
    public readonly status: ScimStatus,
    public readonly scimType: ScimErrorType | undefined,
    detail: string
  ) {
    super(detail);
    this.name = 'ScimError';
  }
}

export interface ScimErrorBody {
  schemas: [typeof SCIM_ERROR_SCHEMA];
  status: string;
  detail: string;
  scimType?: ScimErrorType;
}

export function scimErrorBody(
  status: ScimStatus,
  detail: string,
  scimType?: ScimErrorType
): ScimErrorBody {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail,
    ...(scimType ? { scimType } : {}),
  };
}

export interface ScimEmail {
  value: string;
  type?: string;
  primary?: boolean;
}

export interface ScimName {
  givenName?: string;
  familyName?: string;
  formatted?: string;
}

/** The core User attributes Kyberion stores (RFC 7643 §4.1 subset). */
export interface ScimUserAttributes {
  userName: string;
  externalId?: string;
  displayName?: string;
  name?: ScimName;
  emails?: ScimEmail[];
  active: boolean;
}

const TEXT_MAX = 256;
const EMAIL_MAX = 320;
const EMAILS_MAX = 10;
const PATCH_OPERATIONS_MAX = 50;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(detail: string, scimType: ScimErrorType = 'invalidValue'): ScimError {
  return new ScimError(400, scimType, detail);
}

function text(value: unknown, attribute: string, max = TEXT_MAX): string {
  if (typeof value !== 'string') throw invalid(`${attribute} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL_CHARS.test(trimmed)) {
    throw invalid(`${attribute} must be 1..${max} printable characters`);
  }
  return trimmed;
}

function optionalText(value: unknown, attribute: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return text(value, attribute);
}

/** SCIM booleans; some IdPs (Entra ID) send `"True"` / `"False"` strings in PATCH. */
function bool(value: unknown, attribute: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  throw invalid(`${attribute} must be a boolean`);
}

function parseName(value: unknown): ScimName | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw invalid('name must be an object');
  const name: ScimName = {};
  const givenName = optionalText(value.givenName, 'name.givenName');
  const familyName = optionalText(value.familyName, 'name.familyName');
  const formatted = optionalText(value.formatted, 'name.formatted');
  if (givenName) name.givenName = givenName;
  if (familyName) name.familyName = familyName;
  if (formatted) name.formatted = formatted;
  return Object.keys(name).length ? name : undefined;
}

function parseEmail(value: unknown): ScimEmail {
  if (!isPlainObject(value)) throw invalid('emails entries must be objects');
  const address = text(value.value, 'emails.value', EMAIL_MAX);
  if (!address.includes('@') || /\s/.test(address)) throw invalid('emails.value must be an email');
  const type = optionalText(value.type, 'emails.type');
  const primary = value.primary === undefined ? undefined : bool(value.primary, 'emails.primary');
  return { value: address, ...(type ? { type } : {}), ...(primary ? { primary } : {}) };
}

function parseEmails(value: unknown): ScimEmail[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (list.length > EMAILS_MAX) throw invalid(`at most ${EMAILS_MAX} emails are accepted`);
  const emails = list.map(parseEmail);
  return emails.length ? emails : undefined;
}

/**
 * Validate a POST / PUT User body. Read-only and unknown attributes (`id`,
 * `meta`, `groups`, extension schemas) are ignored, as RFC 7644 §3.3 / §3.5.1
 * allows. `active` defaults to true.
 */
export function parseScimUserInput(body: unknown): ScimUserAttributes {
  if (!isPlainObject(body)) throw invalid('request body must be a JSON object', 'invalidSyntax');
  if (body.schemas !== undefined) {
    if (!Array.isArray(body.schemas) || !body.schemas.includes(SCIM_USER_SCHEMA)) {
      throw invalid(`schemas must include ${SCIM_USER_SCHEMA}`, 'invalidSyntax');
    }
  }
  return normalizeScimUser({
    userName: body.userName as string,
    externalId: body.externalId as string | undefined,
    displayName: body.displayName as string | undefined,
    name: body.name as ScimName | undefined,
    emails: body.emails as ScimEmail[] | undefined,
    active: body.active === undefined ? true : (body.active as boolean),
  });
}

function normalizeScimUser(raw: {
  userName: unknown;
  externalId?: unknown;
  displayName?: unknown;
  name?: unknown;
  emails?: unknown;
  active: unknown;
}): ScimUserAttributes {
  if (raw.userName === undefined || raw.userName === null) {
    throw invalid('userName is required');
  }
  const externalId = optionalText(raw.externalId, 'externalId');
  const displayName = optionalText(raw.displayName, 'displayName');
  const name = parseName(raw.name);
  const emails = parseEmails(raw.emails);
  return {
    userName: text(raw.userName, 'userName'),
    ...(externalId ? { externalId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(name ? { name } : {}),
    ...(emails ? { emails } : {}),
    active: bool(raw.active, 'active'),
  };
}

export interface ScimFilter {
  attribute: 'userName' | 'externalId';
  value: string;
}

const FILTER = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

/**
 * The supported `filter` subset: `userName eq "…"` and `externalId eq "…"`
 * (attribute names and the operator are case-insensitive, RFC 7644 §3.4.2.2).
 * Anything else is a 400 `invalidFilter`, never a silently unfiltered list.
 */
export function parseScimFilter(filter: string | null | undefined): ScimFilter | null {
  if (filter === null || filter === undefined || filter.trim() === '') return null;
  const match = FILTER.exec(filter);
  if (!match) {
    throw invalid(
      'only userName eq "..." and externalId eq "..." filters are supported',
      'invalidFilter'
    );
  }
  let value: string;
  try {
    value = JSON.parse(`"${match[2]}"`) as string;
  } catch {
    throw invalid('filter value is not a valid string', 'invalidFilter');
  }
  const attribute = match[1].toLowerCase() === 'username' ? 'userName' : 'externalId';
  return { attribute, value };
}

/** `userName` is case-insensitive (caseExact false); `externalId` is case-exact. */
export function scimFilterMatches(filter: ScimFilter, user: ScimUserAttributes): boolean {
  if (filter.attribute === 'userName') {
    return user.userName.toLowerCase() === filter.value.toLowerCase();
  }
  return user.externalId === filter.value;
}

function parseIndex(raw: string | null | undefined, name: string, fallback: number): number {
  if (raw === null || raw === undefined || raw.trim() === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) throw invalid(`${name} must be an integer`);
  return Number.parseInt(raw.trim(), 10);
}

/**
 * RFC 7644 §3.4.2.4: a `startIndex` below 1 is read as 1, a negative `count`
 * as 0; `count` is capped at {@link SCIM_MAX_RESULTS}.
 */
export function parseScimPaging(
  startIndex: string | null | undefined,
  count: string | null | undefined
): { startIndex: number; count: number } {
  const start = parseIndex(startIndex, 'startIndex', 1);
  const size = parseIndex(count, 'count', SCIM_DEFAULT_COUNT);
  return {
    startIndex: Math.max(1, start),
    count: Math.min(SCIM_MAX_RESULTS, Math.max(0, size)),
  };
}

const USER_URN_PREFIX = `${SCIM_USER_SCHEMA.toLowerCase()}:`;
const EMAIL_TYPE_PATH = /^emails\[type eq "([^"\\]+)"\](\.value)?$/i;
/**
 * Core User attributes Kyberion does not store. IdP default mappings (Entra
 * ID) patch them on every user, so they are accepted and ignored — as POST /
 * PUT ignore them — instead of failing every sync. Role-like attributes
 * (`roles`, `groups`, `entitlements`) are NOT here: they stay `invalidPath`.
 */
const UNSTORED_CORE_ATTRIBUTES = new Set([
  'nickname',
  'profileurl',
  'title',
  'usertype',
  'preferredlanguage',
  'locale',
  'timezone',
  'phonenumbers',
  'addresses',
  'ims',
  'photos',
  'x509certificates',
]);

function isIgnoredPatchPath(key: string): boolean {
  if (key.startsWith('urn:')) return true; // extension schemas (enterprise User, vendor)
  const attribute = key.split(/[.[]/, 1)[0];
  return UNSTORED_CORE_ATTRIBUTES.has(attribute);
}

type PatchOp = 'add' | 'replace' | 'remove';

function setEmailsOfType(
  emails: ScimEmail[] | undefined,
  type: string,
  value: unknown,
  wholeEntry: boolean
): ScimEmail[] {
  const current = emails ?? [];
  const lowered = type.toLowerCase();
  const others = current.filter((email) => email.type?.toLowerCase() !== lowered);
  const existing = current.find((email) => email.type?.toLowerCase() === lowered);
  const next = wholeEntry ? parseEmail(value) : parseEmail({ ...(existing ?? {}), type, value });
  return [...others, { ...next, type: next.type ?? type }];
}

function applyPatchPath(
  user: ScimUserAttributes,
  op: PatchOp,
  rawPath: string,
  value: unknown
): ScimUserAttributes {
  let path = rawPath.trim();
  if (path.toLowerCase().startsWith(USER_URN_PREFIX)) path = path.slice(USER_URN_PREFIX.length);
  const key = path.toLowerCase();
  const next: ScimUserAttributes = { ...user };
  if (isIgnoredPatchPath(key)) return next;

  const emailType = EMAIL_TYPE_PATH.exec(path);
  if (emailType) {
    const type = emailType[1];
    if (op === 'remove') {
      const remaining = (user.emails ?? []).filter(
        (email) => email.type?.toLowerCase() !== type.toLowerCase()
      );
      if (remaining.length) next.emails = remaining;
      else delete next.emails;
      return next;
    }
    next.emails = setEmailsOfType(user.emails, type, value, !emailType[2]);
    return next;
  }

  switch (key) {
    case 'active':
      if (op === 'remove') throw invalid('active cannot be removed', 'mutability');
      next.active = bool(value, 'active');
      return next;
    case 'username':
      if (op === 'remove') throw invalid('userName is required', 'mutability');
      next.userName = text(value, 'userName');
      return next;
    case 'displayname':
    case 'externalid': {
      const attribute = key === 'displayname' ? 'displayName' : 'externalId';
      const parsed = op === 'remove' ? undefined : optionalText(value, attribute);
      if (parsed) next[attribute] = parsed;
      else delete next[attribute];
      return next;
    }
    case 'name': {
      if (op === 'remove') {
        delete next.name;
        return next;
      }
      const name = parseName(value);
      const merged = op === 'add' ? { ...(user.name ?? {}), ...(name ?? {}) } : name;
      if (merged && Object.keys(merged).length) next.name = merged;
      else delete next.name;
      return next;
    }
    case 'name.givenname':
    case 'name.familyname':
    case 'name.formatted': {
      const field = (['givenName', 'familyName', 'formatted'] as const).find(
        (candidate) => `name.${candidate.toLowerCase()}` === key
      )!;
      const name: ScimName = { ...(user.name ?? {}) };
      const parsed = op === 'remove' ? undefined : optionalText(value, `name.${field}`);
      if (parsed) name[field] = parsed;
      else delete name[field];
      if (Object.keys(name).length) next.name = name;
      else delete next.name;
      return next;
    }
    case 'emails': {
      if (op === 'remove') {
        delete next.emails;
        return next;
      }
      const emails = parseEmails(value) ?? [];
      const combined = op === 'add' ? [...(user.emails ?? []), ...emails] : emails;
      if (combined.length > EMAILS_MAX) throw invalid(`at most ${EMAILS_MAX} emails are accepted`);
      if (combined.length) next.emails = combined;
      else delete next.emails;
      return next;
    }
    default:
      throw invalid(`unsupported attribute path '${rawPath.slice(0, 80)}'`, 'invalidPath');
  }
}

/**
 * Apply an RFC 7644 §3.5.2 PatchOp to a user. Supported: `add` / `replace` /
 * `remove` (case-insensitive — Entra ID sends `Replace`) on `active`,
 * `userName`, `displayName`, `externalId`, `name` and its sub-attributes,
 * `emails`, and `emails[type eq "…"]` (optionally `.value`). A path-less
 * `add`/`replace` takes an object whose keys are paths (Okta's form).
 */
export function applyScimPatch(user: ScimUserAttributes, body: unknown): ScimUserAttributes {
  if (!isPlainObject(body)) throw invalid('request body must be a JSON object', 'invalidSyntax');
  if (!Array.isArray(body.schemas) || !body.schemas.includes(SCIM_PATCH_OP_SCHEMA)) {
    throw invalid(`schemas must include ${SCIM_PATCH_OP_SCHEMA}`, 'invalidSyntax');
  }
  const operations = body.Operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw invalid('Operations must be a non-empty array', 'invalidSyntax');
  }
  if (operations.length > PATCH_OPERATIONS_MAX) {
    throw invalid(`at most ${PATCH_OPERATIONS_MAX} operations are accepted`, 'tooMany');
  }
  let next: ScimUserAttributes = { ...user };
  for (const operation of operations) {
    if (!isPlainObject(operation))
      throw invalid('each operation must be an object', 'invalidSyntax');
    const op = typeof operation.op === 'string' ? operation.op.trim().toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw invalid('op must be add, replace or remove', 'invalidSyntax');
    }
    const path = typeof operation.path === 'string' ? operation.path : undefined;
    if (path !== undefined && path.trim() === '')
      throw invalid('path must not be empty', 'invalidPath');
    if (path) {
      next = applyPatchPath(next, op, path, operation.value);
      continue;
    }
    if (op === 'remove') throw invalid('remove requires a path', 'noTarget');
    if (!isPlainObject(operation.value)) {
      throw invalid('a path-less operation needs an object value', 'invalidValue');
    }
    for (const [attribute, value] of Object.entries(operation.value)) {
      if (attribute === 'schemas' || attribute === 'id' || attribute === 'meta') continue;
      next = applyPatchPath(next, op, attribute, value);
    }
  }
  return normalizeScimUser(next);
}

/** Display name a SCIM user gives the member record (the member schema requires one). */
export function scimDisplayName(user: ScimUserAttributes): string {
  const fromName =
    user.name?.formatted ||
    [user.name?.givenName, user.name?.familyName].filter(Boolean).join(' ').trim();
  return (user.displayName || fromName || user.userName).slice(0, 80);
}

/** The primary email (or the first one), recorded on the bound external identity. */
export function scimPrimaryEmail(user: ScimUserAttributes): string | undefined {
  return (user.emails?.find((email) => email.primary) ?? user.emails?.[0])?.value;
}

export function scimListResponse<T>(
  resources: T[],
  totalResults: number,
  startIndex: number
): {
  schemas: [typeof SCIM_LIST_RESPONSE_SCHEMA];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
} {
  return {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** RFC 7644 §5: what this service provider supports. */
export function scimServiceProviderConfig(baseUrl: string): Record<string, unknown> {
  return {
    schemas: [SCIM_SERVICE_PROVIDER_CONFIG_SCHEMA],
    documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description:
          'Per-organization SCIM provisioning token issued by an organization owner (pnpm organization scim-token issue).',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl}/ServiceProviderConfig` },
  };
}

export function scimUserResourceType(baseUrl: string): Record<string, unknown> {
  return {
    schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    description: 'Kyberion organization member',
    schema: SCIM_USER_SCHEMA,
    meta: { resourceType: 'ResourceType', location: `${baseUrl}/ResourceTypes/User` },
  };
}

function attribute(
  name: string,
  type: 'string' | 'boolean' | 'complex',
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name,
    type,
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...extra,
  };
}

/** RFC 7643 §7: the User schema subset this endpoint stores. */
export function scimUserSchema(baseUrl: string): Record<string, unknown> {
  return {
    schemas: [SCIM_SCHEMA_SCHEMA],
    id: SCIM_USER_SCHEMA,
    name: 'User',
    description: 'Kyberion organization member (core User subset). Roles are not provisioned.',
    attributes: [
      attribute('userName', 'string', { required: true, uniqueness: 'server' }),
      attribute('displayName', 'string'),
      attribute('active', 'boolean'),
      attribute('name', 'complex', {
        subAttributes: [
          attribute('givenName', 'string'),
          attribute('familyName', 'string'),
          attribute('formatted', 'string'),
        ],
      }),
      attribute('emails', 'complex', {
        multiValued: true,
        subAttributes: [
          attribute('value', 'string'),
          attribute('type', 'string'),
          attribute('primary', 'boolean'),
        ],
      }),
    ],
    meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${SCIM_USER_SCHEMA}` },
  };
}
