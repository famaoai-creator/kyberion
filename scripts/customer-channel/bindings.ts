/**
 * The governed writer of `customer/<tenant>/connections/channel-bindings.json`
 * (D8, `pnpm kyberion customer-channel bind|unbind`). The reader is
 * libs/core/customer-channel-binding.ts; this module is the only writer.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import {
  CUSTOMER_CHANNEL_BINDINGS_SCHEMA_PATH,
  isActiveCustomerTenant,
  readTenantCustomerChannelBindings,
  type CustomerBindingSurface,
  type CustomerChannelBinding,
} from '@agent/core/customer-channel-binding';
import { defineCatalog, readJson, writeJson } from '@agent/core/foundation';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import { withLockSync } from '@agent/core/foundation/lock-utils';
import { auditChain } from '@agent/core/governance/audit-chain';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
} from '@agent/core/secure-io';

/**
 * Writes `customer/<tenant>/connections/channel-bindings.json` as the narrow,
 * tenant-bound `customer_channel_binding_store` role: the guard lets it write
 * that one file (and its directories) of the bound tenant, nothing else.
 */
// libs/core/foundation/customer-channel-binding-store-capability.ts CUSTOMER_CHANNEL_BINDING_STORE_ROLE
export const CUSTOMER_CHANNEL_BINDING_WRITE_ROLE = 'customer_channel_binding_store';

export const CUSTOMER_BINDING_SURFACES: readonly CustomerBindingSurface[] = [
  'slack',
  'telegram',
  'email',
  'imessage',
  'discord',
];
const BINDING_MODES = ['sales', 'support', 'requirements_hearing'] as const;
const CHANNEL_ID_PATTERN = /^[^\s\p{Cc}]{1,200}$/u;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const MAX_COUNTERPART_TEXT = 200;

export interface CustomerChannelBindingChange {
  tenantSlug: string;
  surface: string;
  channelId: string;
  name?: string;
  org?: string;
  language?: string;
  mode?: string;
  /** Repository root seam for hermetic callers; defaults to the live root. */
  rootDir?: string;
}

export interface CustomerChannelBindingWriteResult {
  tenant_slug: string;
  file: string;
  binding: CustomerChannelBinding;
  /** `created`, `updated`, `reactivated`, `deactivated` or `unchanged`. */
  change: 'created' | 'updated' | 'reactivated' | 'deactivated' | 'unchanged';
  bindings: number;
}

function bindingFilePath(tenantSlug: string, rootDir: string): string {
  return path.join(rootDir, 'customer', tenantSlug, 'connections', 'channel-bindings.json');
}

function bindingCatalog(filePath: string) {
  return defineCatalog<{ _comment?: string; bindings: CustomerChannelBinding[] }>({
    id: 'customer-channel-binding',
    path: filePath,
    schema: CUSTOMER_CHANNEL_BINDINGS_SCHEMA_PATH,
  });
}

function bindingError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

function textOption(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text || text.length > MAX_COUNTERPART_TEXT || /\p{Cc}/u.test(text)) {
    throw bindingError(
      'CUSTOMER_BINDING_INVALID',
      `${label} must be 1-${MAX_COUNTERPART_TEXT} characters without control characters`
    );
  }
  return text;
}

/** The tenant, surface and channel of a change, validated (fails closed). */
function validatedTarget(input: CustomerChannelBindingChange): {
  tenantSlug: string;
  surface: CustomerBindingSurface;
  channelId: string;
  rootDir: string;
} {
  const rootDir = path.resolve(input.rootDir ?? pathResolver.rootDir());
  if (!isActiveCustomerTenant(input.tenantSlug, { rootDir })) {
    throw bindingError(
      'CUSTOMER_BINDING_TENANT',
      `tenant ${input.tenantSlug} is not registered and active (knowledge/personal/tenants/<tenant>.json)`
    );
  }
  const surface = CUSTOMER_BINDING_SURFACES.find((item) => item === input.surface);
  if (!surface) {
    throw bindingError(
      'CUSTOMER_BINDING_INVALID',
      `--surface must be one of ${CUSTOMER_BINDING_SURFACES.join('|')}`
    );
  }
  const channelId = String(input.channelId ?? '').trim();
  if (!CHANNEL_ID_PATTERN.test(channelId)) {
    throw bindingError(
      'CUSTOMER_BINDING_INVALID',
      '--channel must be 1-200 characters without whitespace or control characters'
    );
  }
  return { tenantSlug: input.tenantSlug, surface, channelId, rootDir };
}

/** The tenant's bindings file as written (an invalid file is refused, never overwritten). */
function readBindingsForWrite(filePath: string): {
  _comment?: string;
  bindings: CustomerChannelBinding[];
} {
  if (!safeExistsSync(filePath)) return { bindings: [] };
  try {
    return bindingCatalog(filePath).validate(readJson<unknown>(filePath), filePath);
  } catch (err) {
    throw bindingError(
      'CUSTOMER_BINDING_FILE_INVALID',
      `${filePath} does not validate against customer-channel-binding.schema.json; fix it first (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

function writeBindingChange(
  target: ReturnType<typeof validatedTarget>,
  operation: 'bind' | 'unbind',
  apply: (bindings: CustomerChannelBinding[]) => {
    bindings: CustomerChannelBinding[];
    binding: CustomerChannelBinding | null;
    change: CustomerChannelBindingWriteResult['change'];
  }
): CustomerChannelBindingWriteResult | null {
  const { tenantSlug, rootDir } = target;
  return withLockSync(`customer-channel-bindings-${tenantSlug}`, () => {
    // The store role writes the bindings file only; the audit record (its own
    // lock and chain) is written under the caller's identity.
    const written = withExecutionContext(
      CUSTOMER_CHANNEL_BINDING_WRITE_ROLE,
      () => {
        const filePath = assertSafeRepositoryPath(bindingFilePath(tenantSlug, rootDir), {
          rootDir,
          allowMissingLeaf: true,
        });
        const current = readBindingsForWrite(filePath);
        const next = apply(current.bindings);
        if (!next.binding) return null;
        if (next.change !== 'unchanged') {
          const document = {
            ...(current._comment !== undefined ? { _comment: current._comment } : {}),
            bindings: next.bindings,
          };
          const validated = bindingCatalog(filePath).validate(document, filePath);
          safeMkdir(path.dirname(filePath), { recursive: true });
          writeJson(filePath, validated);
        }
        return {
          tenant_slug: tenantSlug,
          file: path.relative(rootDir, filePath),
          binding: next.binding,
          change: next.change,
          bindings: next.bindings.length,
        };
      },
      undefined,
      tenantSlug
    );
    if (!written) return null;
    const next = written;
    auditChain.record({
      agentId: 'customer-channel',
      action: 'customer_channel_binding',
      operation,
      result: 'completed',
      tenantSlug,
      metadata: {
        surface: next.binding.surface,
        channel_id: next.binding.channel_id,
        change: next.change,
        active: next.binding.active !== false,
        ...(next.binding.mode ? { mode: next.binding.mode } : {}),
      },
    });
    return written;
  });
}

/**
 * Another registered, active tenant with this channel bound and active, or
 * null. Each tenant is checked through its own tenant-bound read
 * (`readTenantCustomerChannelBindings`), so the scan needs no personal-tier
 * persona.
 */
function otherTenantBindingChannel(target: ReturnType<typeof validatedTarget>): string | null {
  let slugs: string[];
  try {
    const customerRoot = assertSafeRepositoryPath(path.join(target.rootDir, 'customer'), {
      rootDir: target.rootDir,
    });
    slugs = safeExistsSync(customerRoot) ? safeReaddir(customerRoot) : [];
  } catch {
    return null;
  }
  for (const slug of slugs.sort()) {
    if (slug === target.tenantSlug || !isValidTenantSlug(slug)) continue;
    const bound = readTenantCustomerChannelBindings(slug, { rootDir: target.rootDir }).some(
      (item) =>
        item.active !== false &&
        item.surface === target.surface &&
        item.channel_id === target.channelId
    );
    if (bound) return slug;
  }
  return null;
}

/**
 * Create or update (and reactivate) the tenant's binding of one surface
 * channel. Refused when the tenant is not registered and active, when an
 * option is malformed, when the existing file does not validate, or when
 * another tenant has the same channel bound (inbound routing takes the first
 * match, so a channel belongs to one tenant).
 */
export function bindCustomerChannel(
  input: CustomerChannelBindingChange
): CustomerChannelBindingWriteResult {
  const target = validatedTarget(input);
  const name = textOption(input.name, '--name');
  const org = textOption(input.org, '--org');
  const language = input.language?.trim();
  if (language !== undefined && !LANGUAGE_PATTERN.test(language)) {
    throw bindingError('CUSTOMER_BINDING_INVALID', '--language must be a language tag (ja, en-US)');
  }
  const mode = BINDING_MODES.find((item) => item === input.mode);
  if (input.mode !== undefined && !mode) {
    throw bindingError(
      'CUSTOMER_BINDING_INVALID',
      `--mode must be one of ${BINDING_MODES.join('|')}`
    );
  }
  const elsewhere = otherTenantBindingChannel(target);
  if (elsewhere) {
    throw bindingError(
      'CUSTOMER_BINDING_CONFLICT',
      `${target.surface}:${target.channelId} is already bound to another tenant; unbind it there first`
    );
  }
  const result = writeBindingChange(target, 'bind', (bindings) => {
    const index = bindings.findIndex(
      (item) => item.surface === target.surface && item.channel_id === target.channelId
    );
    const existing = index >= 0 ? bindings[index] : undefined;
    const counterpart =
      name !== undefined || org !== undefined
        ? {
            ...existing?.counterpart,
            ...(name !== undefined ? { name } : {}),
            ...(org !== undefined ? { org } : {}),
          }
        : existing?.counterpart;
    const { active: _active, ...rest } = existing ?? {};
    const binding: CustomerChannelBinding = {
      ...rest,
      surface: target.surface,
      channel_id: target.channelId,
      ...(counterpart ? { counterpart } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(mode ? { mode } : {}),
      active: true,
    };
    const change: CustomerChannelBindingWriteResult['change'] = !existing
      ? 'created'
      : existing.active === false
        ? 'reactivated'
        : JSON.stringify(existing) === JSON.stringify(binding)
          ? 'unchanged'
          : 'updated';
    const next = [...bindings];
    if (index >= 0) next[index] = binding;
    else next.push(binding);
    return { bindings: next, binding, change };
  });
  return result!;
}

/**
 * Deactivate the tenant's binding of one surface channel (`active: false`,
 * kept for the record; `bind` reactivates it). Null when there is none.
 */
export function unbindCustomerChannel(
  input: CustomerChannelBindingChange
): CustomerChannelBindingWriteResult | null {
  const target = validatedTarget(input);
  return writeBindingChange(target, 'unbind', (bindings) => {
    const index = bindings.findIndex(
      (item) => item.surface === target.surface && item.channel_id === target.channelId
    );
    if (index < 0) return { bindings, binding: null, change: 'unchanged' };
    const existing = bindings[index];
    const binding: CustomerChannelBinding = { ...existing, active: false };
    const next = [...bindings];
    next[index] = binding;
    return {
      bindings: next,
      binding,
      change: existing.active === false ? 'unchanged' : 'deactivated',
    };
  });
}
