/** Durable, scope-aware storage for the unified local-pads surface. */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeUnlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { isReservedScopeName, isValidTenantSlug } from '@agent/core/entity-scope';
import { assertSafeRepositoryPath, pathResolver, toRepoRelative } from '@agent/core/path-resolver';
import { withLockSync } from '@agent/core/lock-utils';
import { nowIso, readJson } from '@agent/core/foundation';
import type { EventScope } from '@agent/core/event-scope';
import type { PadId } from './registry.js';
import { toLegacyHandoffProjection } from './legacy.js';

export type PadTier = 'public' | 'confidential' | 'personal';

export interface PadStoragePolicy {
  id: string;
  tier: PadTier;
  retention_days: number | null;
  partition: 'shared' | 'tenant' | 'tenant-owner';
}

export const PAD_STORAGE_POLICIES: readonly PadStoragePolicy[] = [
  { id: 'pad.personal.v1', tier: 'personal', retention_days: null, partition: 'tenant-owner' },
  {
    id: 'pad.confidential.v1',
    tier: 'confidential',
    retention_days: 365,
    partition: 'tenant',
  },
  { id: 'pad.public.v1', tier: 'public', retention_days: 90, partition: 'shared' },
] as const;

/** A viewer may narrow from its server-bound tier toward less sensitive tiers. */
export function allowedPadTiers(tier: PadTier): readonly PadTier[] {
  if (tier === 'personal') return ['personal', 'confidential', 'public'];
  if (tier === 'confidential') return ['confidential', 'public'];
  return ['public'];
}

export interface PadRecord {
  record_id: string;
  pad_id: PadId;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  viewer_principal: string;
  scope: EventScope;
  tier: PadTier;
  storage_policy_id: string;
  storage_policy_version: string;
  adapter_id: string;
  adapter_schema_version: string;
  payload: Readonly<Record<string, string>>;
  artifact_manifest: readonly string[];
  artifact_refs: readonly PadArtifactRef[];
  content_sha256: string;
  idempotency_key?: string;
  handoff_ref?: string;
}

export interface PadArtifactRef {
  artifact_id: string;
  field_id: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface PadArtifactInput {
  field_id: string;
  name: string;
  mime: string;
  data_base64: string;
}

export interface PadHistoryQuery {
  pad_id?: PadId;
  cursor?: string;
  limit?: number;
}

const POLICY_VERSION = '1';

export function defaultPadStorageRoot(): string {
  return pathResolver.shared('local-pads');
}

function hashPrincipal(principal: string): string {
  return createHash('sha256').update(principal).digest('hex').slice(0, 24);
}

function tenantSegment(scope: EventScope): string {
  const tenant = scope.tenant_slug?.trim();
  if (
    scope.tier !== 'public' &&
    (!tenant || !isValidTenantSlug(tenant) || isReservedScopeName(tenant))
  ) {
    throw new Error('tenant scope is required for confidential and personal pad storage');
  }
  if (tenant && (!isValidTenantSlug(tenant) || isReservedScopeName(tenant))) {
    throw new Error('invalid tenant scope');
  }
  return tenant || 'shared';
}

function contextSegment(label: string, value: string | undefined): string[] {
  if (!value) return [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${label} scope segment is invalid`);
  }
  return [label, value];
}

export function resolvePadStorage(
  scope: Pick<
    EventScope,
    'tier' | 'tenant_slug' | 'organization_id' | 'project_id' | 'mission_id' | 'task_id'
  >,
  viewerPrincipal: string,
  padId: PadId,
  policyId?: string,
  root = defaultPadStorageRoot()
): {
  root: string;
  records: string;
  payloads: string;
  artifacts: string;
  handoffs: string;
  policy: PadStoragePolicy;
} {
  const safeRoot = assertSafeRepositoryPath(root, { allowMissingLeaf: true });
  const sharedRoot = path.resolve(pathResolver.active('shared'));
  const rootRelative = path.relative(sharedRoot, safeRoot);
  if (
    rootRelative === '..' ||
    rootRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rootRelative)
  ) {
    throw new Error('local pads storage root must remain under active/shared');
  }
  const tier = scope.tier as PadTier;
  const policy = policyId
    ? PAD_STORAGE_POLICIES.find((candidate) => candidate.id === policyId)
    : PAD_STORAGE_POLICIES.find((candidate) => candidate.tier === tier);
  if (policyId && !policy) throw new Error('storage policy is not registered');
  if (!policy || policy.tier !== tier) throw new Error('storage policy does not match scope tier');
  if (!viewerPrincipal.trim()) throw new Error('viewer principal is required');
  // Public records without a tenant use the shared partition. If a server is
  // tenant-bound, retain that tenant in the path so one tenant's public
  // history cannot become another tenant's listing.
  const tenant = tenantSegment(scope as EventScope);
  const owner =
    policy.partition === 'tenant-owner' ? `owners/${hashPrincipal(viewerPrincipal)}` : '';
  const contextPath = [
    ...contextSegment('organization', scope.organization_id),
    ...contextSegment('project', scope.project_id),
    ...contextSegment('mission', scope.mission_id),
    ...contextSegment('task', scope.task_id),
  ];
  const scoped = path.join(safeRoot, tier, tenant, ...contextPath, owner, padId);
  return {
    root: safeRoot,
    records: path.join(scoped, 'records'),
    payloads: path.join(scoped, 'payloads'),
    artifacts: path.join(scoped, 'artifacts'),
    handoffs: path.join(scoped, 'handoffs'),
    policy,
  };
}

function parseRecords(file: string): PadRecord[] {
  if (!safeExistsSync(file)) return [];
  try {
    const parsed: unknown = readJson<unknown>(file);
    return Array.isArray(parsed)
      ? parsed.filter((row): row is PadRecord =>
          Boolean(
            row && typeof row === 'object' && typeof (row as PadRecord).record_id === 'string'
          )
        )
      : [];
  } catch {
    return [];
  }
}

function indexPath(storage: ReturnType<typeof resolvePadStorage>): string {
  return path.join(storage.records, 'index.json');
}

export class PadRecordStore {
  readonly storage: ReturnType<typeof resolvePadStorage>;

  constructor(
    readonly scope: EventScope,
    readonly viewerPrincipal: string,
    readonly padId: PadId,
    policyId?: string,
    root?: string
  ) {
    this.storage = resolvePadStorage(scope, viewerPrincipal, padId, policyId, root);
  }

  list(query: PadHistoryQuery = {}): { records: PadRecord[]; next_cursor?: string } {
    const records = parseRecords(indexPath(this.storage))
      .filter(
        (row) =>
          row.pad_id === this.padId && isPadRecordVisible(row, this.scope, this.viewerPrincipal)
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const page = records.slice(start, start + limit);
    const next = start + page.length < records.length ? String(start + page.length) : undefined;
    return next ? { records: page, next_cursor: next } : { records: page };
  }

  get(recordId: string): PadRecord | undefined {
    return parseRecords(indexPath(this.storage)).find(
      (row) =>
        row.record_id === recordId && isPadRecordVisible(row, this.scope, this.viewerPrincipal)
    );
  }

  save(input: {
    title?: string;
    body: string;
    artifact_manifest?: readonly string[];
    idempotency_key?: string;
    handoff_ref?: string;
    adapter_id?: string;
    adapter_schema_version?: string;
    payload?: Readonly<Record<string, string>>;
    artifacts?: readonly PadArtifactInput[];
    now?: string;
  }): PadRecord {
    // The index is a read/modify/write aggregate.  Keep the idempotency check,
    // payload/artifact writes, and index replacement under one per-scope
    // process fence so two requests cannot silently overwrite one another.
    const lockId = `personal-pad-store-${createHash('sha256')
      .update(this.storage.records)
      .digest('hex')
      .slice(0, 32)}`;
    return withLockSync(lockId, () => this.saveUnlocked(input));
  }

  private saveUnlocked(input: {
    title?: string;
    body: string;
    artifact_manifest?: readonly string[];
    idempotency_key?: string;
    handoff_ref?: string;
    adapter_id?: string;
    adapter_schema_version?: string;
    payload?: Readonly<Record<string, string>>;
    artifacts?: readonly PadArtifactInput[];
    now?: string;
  }): PadRecord {
    const now = input.now ?? nowIso();
    const requestedHandoffRef = input.handoff_ref
      ? toRepoRelative(assertSafeRepositoryPath(input.handoff_ref, { allowMissingLeaf: true }))
      : undefined;
    const idempotencyKey = input.idempotency_key?.trim().slice(0, 200) || undefined;
    if (idempotencyKey) {
      const existing = parseRecords(indexPath(this.storage)).find(
        (row) =>
          row.idempotency_key === idempotencyKey &&
          isPadRecordVisible(row, this.scope, this.viewerPrincipal)
      );
      if (existing) return existing;
    }
    const recordId = `${this.padId}-${randomUUID()}`;
    const payloadPath = path.join(this.storage.payloads, `${recordId}.json`);
    const handoffPath = path.join(this.storage.handoffs, `${recordId}.json`);
    // Every durable capture has a scoped handoff, even when the caller did
    // not provide one.  This makes saved records valid evidence inputs for
    // governed follow-up actions after a restart.
    const handoffRef =
      requestedHandoffRef ??
      toRepoRelative(assertSafeRepositoryPath(handoffPath, { allowMissingLeaf: true }));
    const artifactRefs: PadArtifactRef[] = [];
    const artifactPaths: string[] = [];
    try {
      for (const [index, artifact] of (input.artifacts ?? []).entries()) {
        const encoded = artifact.data_base64.trim();
        if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
          throw new Error('artifact data must be valid base64');
        }
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.byteLength < 1 || bytes.byteLength > 12 * 1024 * 1024) {
          throw new Error('artifact exceeds 12 MiB limit');
        }
        const safeName =
          String(artifact.name || `artifact-${index + 1}`)
            .replace(/[^A-Za-z0-9._-]+/gu, '_')
            .replace(/^\.+/u, '')
            .slice(0, 120) || `artifact-${index + 1}`;
        const digest = createHash('sha256').update(bytes).digest('hex');
        const artifactId = `${String(index + 1).padStart(2, '0')}-${digest.slice(0, 16)}`;
        const artifactPath = path.join(
          this.storage.artifacts,
          recordId,
          `${artifactId}-${safeName}`
        );
        artifactPaths.push(artifactPath);
        artifactRefs.push({
          artifact_id: artifactId,
          field_id: String(artifact.field_id).slice(0, 80),
          name: safeName,
          mime: String(artifact.mime || 'application/octet-stream').slice(0, 200),
          bytes: bytes.byteLength,
          sha256: digest,
        });
        safeWriteFile(artifactPath, bytes, { mkdir: true });
      }
    } catch (error) {
      for (const artifactPath of artifactPaths) safeUnlinkSync(artifactPath);
      throw error;
    }
    const storedBody = input.body.slice(0, 2_000_000);
    const record: PadRecord = {
      record_id: recordId,
      pad_id: this.padId,
      title: String(input.title ?? '')
        .trim()
        .slice(0, 200),
      body: storedBody,
      created_at: now,
      updated_at: now,
      viewer_principal: this.viewerPrincipal,
      scope: this.scope,
      tier: this.scope.tier as PadTier,
      storage_policy_id: this.storage.policy.id,
      storage_policy_version: POLICY_VERSION,
      adapter_id: input.adapter_id ?? `${this.padId}.legacy`,
      adapter_schema_version: input.adapter_schema_version ?? '1',
      payload: Object.fromEntries(
        Object.entries(input.payload ?? {})
          .slice(0, 64)
          .map(([key, value]) => [
            key.slice(0, 80),
            String(value).slice(0, key === 'body' ? 2_000_000 : 50_000),
          ])
      ),
      artifact_manifest: (input.artifact_manifest ?? []).map(String).slice(0, 100),
      artifact_refs: artifactRefs,
      content_sha256: createHash('sha256').update(storedBody).digest('hex'),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(handoffRef ? { handoff_ref: handoffRef } : {}),
    };
    try {
      safeMkdir(this.storage.records, { recursive: true });
      safeMkdir(this.storage.payloads, { recursive: true });
      safeWriteFile(payloadPath, JSON.stringify(record), {
        mkdir: true,
        encoding: 'utf8',
      });
      safeWriteFile(
        handoffPath,
        JSON.stringify(
          {
            kind: 'personal-pad-handoff',
            version: 1,
            record_id: record.record_id,
            pad_id: record.pad_id,
            adapter_id: record.adapter_id,
            scope: record.scope,
            viewer_principal: record.viewer_principal,
            created_at: record.created_at,
            title: record.title,
            body: record.body,
            payload: record.payload,
            artifact_manifest: record.artifact_manifest,
            artifact_refs: record.artifact_refs,
            processing: { auto_start_mission: false, auto_knowledge_commit: false },
            compatibility: toLegacyHandoffProjection(record),
          },
          null,
          2
        ),
        { mkdir: true, encoding: 'utf8' }
      );
      const records = parseRecords(indexPath(this.storage));
      records.push(record);
      safeWriteFile(indexPath(this.storage), JSON.stringify(records, null, 2), {
        mkdir: true,
        encoding: 'utf8',
      });
    } catch (error) {
      safeUnlinkSync(payloadPath);
      safeUnlinkSync(handoffPath);
      for (const artifactPath of artifactPaths) safeUnlinkSync(artifactPath);
      throw error;
    }
    return record;
  }

  readArtifact(
    recordId: string,
    artifactId: string
  ): { ref: PadArtifactRef; data_base64: string } | undefined {
    const record = this.get(recordId);
    if (!record) return undefined;
    const refs = Array.isArray(record.artifact_refs) ? record.artifact_refs : [];
    const ref = refs.find((candidate) => candidate.artifact_id === artifactId);
    if (!ref || !/^[0-9]{2}-[a-f0-9]{16}$/u.test(ref.artifact_id)) return undefined;
    const artifactDir = path.join(this.storage.artifacts, record.record_id);
    if (!safeExistsSync(artifactDir)) return undefined;
    const file = safeReaddir(artifactDir).find((name) => name.startsWith(`${ref.artifact_id}-`));
    if (!file) return undefined;
    const bytes = safeReadFile(path.join(artifactDir, file), { encoding: null });
    if (!Buffer.isBuffer(bytes)) return undefined;
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== ref.sha256) return undefined;
    return { ref, data_base64: bytes.toString('base64') };
  }

  rebuildIndex(): number {
    const lockId = `personal-pad-store-${createHash('sha256')
      .update(this.storage.records)
      .digest('hex')
      .slice(0, 32)}`;
    return withLockSync(lockId, () => this.rebuildIndexUnlocked());
  }

  private rebuildIndexUnlocked(): number {
    if (!safeExistsSync(this.storage.payloads)) return 0;
    const records = safeReaddir(this.storage.payloads)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const fileRecordId = name.slice(0, -'.json'.length);
        try {
          const value: unknown = readJson<unknown>(path.join(this.storage.payloads, name));
          if (
            !value ||
            typeof value !== 'object' ||
            (value as PadRecord).record_id !== fileRecordId ||
            !safeExistsSync(path.join(this.storage.handoffs, `${fileRecordId}.json`))
          ) {
            // A payload without its matching handoff is an interrupted
            // capture.  Leave it quarantined for an operator rather than
            // exposing a half-committed record through history.
            return null;
          }
          return value &&
            typeof value === 'object' &&
            typeof (value as PadRecord).record_id === 'string'
            ? (value as PadRecord)
            : null;
        } catch {
          return null;
        }
      })
      .filter((value): value is PadRecord => value !== null);
    safeWriteFile(indexPath(this.storage), JSON.stringify(records, null, 2), {
      mkdir: true,
      encoding: 'utf8',
    });
    return records.length;
  }
}

export function isPadRecordVisible(
  record: PadRecord,
  scope: EventScope,
  principal: string
): boolean {
  // The physical partition is defense in depth, not the authorization check.
  // Keep the full typed context in the comparison so a record copied into an
  // otherwise valid index cannot cross an organization/project/mission/task
  // boundary merely because its tenant and tier match.
  const scopeKeys: Array<keyof EventScope> = [
    'scope_kind',
    'tier',
    'tenant_slug',
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
    'session_id',
  ];
  if (scopeKeys.some((key) => record.scope?.[key] !== scope[key])) return false;
  return record.tier !== 'personal' || record.viewer_principal === principal;
}
