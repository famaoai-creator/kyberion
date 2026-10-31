import { readJson, writeJson } from '../foundation/json.js';
/** Local multimodal retrieval. Index scope is checked against runtime authority on every call. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { currentScope } from '../scope-context.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { pathResolver } from '../path-resolver.js';
import { resolveStorageFloor, classifyStorageFloorPath } from '../storage-layout.js';
import { detectTier } from '../tier-guard.js';
import { tenantOfPath } from '../video/ingest/video-brief.js';
import {
  assertSafeRepositoryPath,
  safeExecResultAsync,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReadFileRange,
  safeReaddir,
} from '../secure-io.js';

export interface SemanticScope {
  tier: 'public' | 'confidential' | 'personal';
  tenant_slug?: string;
}
export interface SemanticMediaEntry {
  id: string;
  path: string;
  text?: string;
  image_path?: string;
  time_sec?: number;
  end_sec?: number;
}
export type SemanticEmbeddingInput = { text: string } | { imagePath: string };
export interface SemanticEmbeddingProvider {
  /** Includes model revision. Documents and queries must use exactly the same identity. */
  identity: string;
  embed(inputs: readonly SemanticEmbeddingInput[]): Promise<number[][]>;
}
export interface SemanticModelOptions {
  modelPath: string;
  python?: string;
  timeoutMs?: number;
}
export interface SemanticIndexOptions extends SemanticModelOptions {
  indexId: string;
  scope: SemanticScope;
  entries: readonly SemanticMediaEntry[];
  ttlSeconds?: number;
}
export interface SemanticSearchOptions extends SemanticModelOptions {
  indexId: string;
  scope: SemanticScope;
  query: string;
  limit?: number;
}
export interface SemanticIndexReceipt {
  index_id: string;
  entries: number;
  provider: string;
  expires_at: string;
  index_path: string;
}
export interface SemanticSearchHit extends SemanticMediaEntry {
  score: number;
}
interface StoredEntry extends SemanticMediaEntry {
  vector: number[];
  source: FileVersion;
  image_sha256?: string;
}
interface FileVersion {
  size: number;
  mtime_ms: number;
  sha256: string;
}
interface StoredIndex {
  version: 1;
  scope: SemanticScope;
  provider: string;
  dimensions: number;
  created_at: number;
  expires_at: number;
  entries: StoredEntry[];
}
const MAX_ENTRIES = 512;
const MAX_DIMENSIONS = 4096;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const TIER_RANK = { public: 0, confidential: 1, personal: 2 } as const;

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error('[SEMANTIC_INVALID] ' + label);
  return value;
}
function validScope(scope: SemanticScope, write: boolean): SemanticScope {
  if (!scope || !Object.hasOwn(TIER_RANK, scope.tier))
    throw new Error('[SEMANTIC_SCOPE] Invalid tier');
  const envelope = currentScopeEnvelope();
  const authority = envelope?.identity ?? currentScope();
  if (authority.tier !== scope.tier || (authority.tenant_slug ?? '') !== (scope.tenant_slug ?? ''))
    throw new Error('[SEMANTIC_SCOPE] Requested scope differs from runtime scope');
  if (scope.tier !== 'public' && !scope.tenant_slug)
    throw new Error('[SEMANTIC_SCOPE] Private index requires tenant');
  if (
    envelope &&
    (!envelope.policy.read_tiers.includes(scope.tier) ||
      (write && envelope.policy.write_tier !== scope.tier))
  )
    throw new Error('[SEMANTIC_SCOPE] Envelope does not permit index access');
  return { tier: scope.tier, ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}) };
}
function indexPath(indexId: string, scope: SemanticScope): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(indexId))
    throw new Error('[SEMANTIC_INVALID] indexId');
  return assertSafeRepositoryPath(
    resolveStorageFloor(
      'cache',
      { kind: 'tier', tier: scope.tier, tenant: scope.tenant_slug },
      'perception',
      'semantic',
      indexId + '.json'
    ),
    { allowMissingLeaf: true }
  );
}
function sourcePath(file: string, scope: SemanticScope): string {
  const absolute = assertSafeRepositoryPath(
    pathResolver.rootResolve(boundedText(file, 'path', 2048))
  );
  const relative = path.relative(pathResolver.rootDir(), absolute).split(path.sep).join('/');
  const segments = relative.split('/');
  const tier = segments.includes('personal')
    ? 'personal'
    : segments.includes('confidential')
      ? 'confidential'
      : detectTier(absolute);
  if (TIER_RANK[tier] > TIER_RANK[scope.tier])
    throw new Error('[SEMANTIC_SCOPE] Source tier exceeds index tier');
  const floor = classifyStorageFloorPath(absolute);
  const tenant = floor?.partition.kind === 'tier' ? floor.partition.tenant : tenantOfPath(absolute);
  if (tenant && tenant !== scope.tenant_slug)
    throw new Error('[SEMANTIC_SCOPE] Source tenant differs from index tenant');
  if (!safeLstat(absolute).isFile())
    throw new Error('[SEMANTIC_SOURCE] Input must be a regular file');
  return absolute;
}
function version(file: string): FileVersion {
  const before = safeLstat(file);
  if (!before.isFile() || before.size > 8 * 1024 * 1024 * 1024)
    throw new Error('[SEMANTIC_SOURCE] Regular file of at most 8 GiB required');
  const hash = createHash('sha256');
  for (let offset = 0; offset < before.size; offset += 1048576)
    hash.update(safeReadFileRange(file, offset, Math.min(1048576, before.size - offset)));
  const after = safeLstat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('[SEMANTIC_STALE] Source changed during hashing');
  return { size: before.size, mtime_ms: before.mtimeMs, sha256: hash.digest('hex') };
}
function assertVersion(file: string, expected: FileVersion): void {
  const actual = version(file);
  if (
    actual.size !== expected.size ||
    actual.mtime_ms !== expected.mtime_ms ||
    actual.sha256 !== expected.sha256
  )
    throw new Error('[SEMANTIC_STALE] Source changed; rebuild index');
}
function vector(raw: unknown, dimensions?: number): number[] {
  if (
    !Array.isArray(raw) ||
    raw.length < 2 ||
    raw.length > MAX_DIMENSIONS ||
    (dimensions !== undefined && raw.length !== dimensions) ||
    raw.some((x) => typeof x !== 'number' || !Number.isFinite(x))
  )
    throw new Error('[SEMANTIC_VECTOR] Invalid dimensions or components');
  const norm = Math.hypot(...raw);
  if (!Number.isFinite(norm) || norm <= 1e-12) throw new Error('[SEMANTIC_VECTOR] Empty vector');
  return raw.map((x) => x / norm);
}
function entry(raw: SemanticMediaEntry): SemanticMediaEntry {
  const id = boundedText(raw.id, 'entry id', 128);
  const source = boundedText(raw.path, 'entry path', 2048);
  if (raw.text !== undefined) boundedText(raw.text, 'entry text', 16384);
  for (const time of [raw.time_sec, raw.end_sec])
    if (time !== undefined && (!Number.isFinite(time) || time < 0))
      throw new Error('[SEMANTIC_INVALID] Entry time');
  if (raw.end_sec !== undefined && raw.end_sec < (raw.time_sec ?? 0))
    throw new Error('[SEMANTIC_INVALID] Inverted entry time');
  return {
    id,
    path: source,
    ...(raw.text !== undefined ? { text: raw.text } : {}),
    ...(raw.image_path !== undefined ? { image_path: raw.image_path } : {}),
    ...(raw.time_sec !== undefined ? { time_sec: raw.time_sec } : {}),
    ...(raw.end_sec !== undefined ? { end_sec: raw.end_sec } : {}),
  };
}
function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function decodeIndex(raw: unknown, scope: SemanticScope): StoredIndex {
  if (!raw || typeof raw !== 'object') throw new Error('[SEMANTIC_INDEX] Invalid index');
  const x = raw as StoredIndex;
  if (
    x.version !== 1 ||
    x.scope?.tier !== scope.tier ||
    (x.scope?.tenant_slug ?? '') !== (scope.tenant_slug ?? '') ||
    !finiteTime(x.created_at) ||
    !finiteTime(x.expires_at) ||
    x.expires_at <= x.created_at ||
    !Number.isInteger(x.dimensions) ||
    x.dimensions < 2 ||
    x.dimensions > MAX_DIMENSIONS ||
    !Array.isArray(x.entries) ||
    x.entries.length === 0 ||
    x.entries.length > MAX_ENTRIES
  )
    throw new Error('[SEMANTIC_INDEX] Invalid metadata');
  boundedText(x.provider, 'provider', 1024);
  const ids = new Set<string>();
  for (const row of x.entries) {
    entry(row);
    if (ids.has(row.id)) throw new Error('[SEMANTIC_INDEX] Duplicate id');
    ids.add(row.id);
    if (
      !row.source ||
      !finiteTime(row.source.size) ||
      !finiteTime(row.source.mtime_ms) ||
      !/^[a-f0-9]{64}$/u.test(row.source.sha256)
    )
      throw new Error('[SEMANTIC_INDEX] Invalid source version');
    if (row.image_path !== undefined)
      throw new Error('[SEMANTIC_INDEX] Transient image paths cannot be persisted');
    row.vector = vector(row.vector, x.dimensions);
  }
  return x;
}

/** No network or remote Python code. This provider supports locally installed CLIP / SigLIP models. */
export function createLocalMultimodalEmbeddingProvider(
  options: SemanticModelOptions
): SemanticEmbeddingProvider {
  const model = assertSafeRepositoryPath(pathResolver.rootResolve(options.modelPath));
  if (!safeLstat(model).isDirectory()) throw new Error('[SEMANTIC_MODEL] Model directory required');
  const config = assertSafeRepositoryPath(path.join(model, 'config.json'));
  if (safeLstat(config).size > 1048576) throw new Error('[SEMANTIC_MODEL] Oversized config');
  const configText = String(safeReadFile(config));
  const configData = JSON.parse(configText) as { model_type?: string };
  if (!['clip', 'siglip', 'siglip2'].includes(configData.model_type ?? ''))
    throw new Error(
      '[SEMANTIC_MODEL] Use a local CLIP or SigLIP model with built-in Transformers support, provisioned under active/shared/cache/system/perception-models/ (or another repo path the scope may read — public or own-tenant tmp/staging)'
    );
  // Cryptographic identity covers all local config/tokenizer/weight assets in bounded reads.
  const assetNames = safeReaddir(model)
    .sort()
    .filter((name) => /\.(json|safetensors|bin|model|txt)$/u.test(name));
  if (assetNames.length > 128) throw new Error('[SEMANTIC_MODEL] Model has more than 128 assets');
  let modelBytes = 0;
  const assets = assetNames.map((name) => {
    const asset = assertSafeRepositoryPath(path.join(model, name));
    const s = safeLstat(asset);
    if (!s.isFile()) throw new Error('[SEMANTIC_MODEL] Model assets must be regular files');
    modelBytes += s.size;
    if (modelBytes > 8 * 1024 * 1024 * 1024)
      throw new Error('[SEMANTIC_MODEL] Model assets exceed 8 GiB');
    return [name, version(asset).sha256];
  });
  if (!assets.some((asset) => String(asset[0]).endsWith('.safetensors')))
    throw new Error(
      '[SEMANTIC_MODEL] Local safetensors weights required; pickle checkpoints are refused'
    );
  const identity =
    'transformers-' +
    configData.model_type +
    ':' +
    createHash('sha256')
      .update(model)
      .update(configText)
      .update(JSON.stringify(assets))
      .digest('hex');
  const timeout = options.timeoutMs ?? 120000;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 600000)
    throw new Error('[SEMANTIC_INVALID] timeoutMs');
  return {
    identity,
    async embed(inputs) {
      if (inputs.length < 1 || inputs.length > 32)
        throw new Error('[SEMANTIC_INVALID] Embedding batch must contain 1..32 entries');
      const active = currentScopeEnvelope()?.identity ?? currentScope();
      const runtimeScope = validScope(
        {
          tier: active.tier as SemanticScope['tier'],
          ...(active.tenant_slug ? { tenant_slug: active.tenant_slug } : {}),
        },
        false
      );
      const validatedInputs = inputs.map((input) => {
        if ('text' in input) return { text: boundedText(input.text, 'embedding text', 16384) };
        return { imagePath: sourcePath(input.imagePath, runtimeScope) };
      });
      const result = await safeExecResultAsync(
        options.python ?? 'python3',
        [pathResolver.rootResolve('libs/core/perception/semantic-embedding.py')],
        {
          timeoutMs: timeout,
          maxOutputMB: 4,
          input: JSON.stringify({ model_path: model, inputs: validatedInputs }),
          env: {
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
            HF_HUB_DISABLE_TELEMETRY: '1',
            TOKENIZERS_PARALLELISM: 'false',
          },
        }
      );
      if (result.status !== 0 || result.error)
        throw new Error(
          '[SEMANTIC_UNAVAILABLE] Install torch, transformers and Pillow in the selected Python runtime; supply an existing local model (e.g. under active/shared/cache/system/perception-models/). ' +
            String(result.stderr || result.error?.message).slice(0, 2048)
        );
      let decoded: unknown;
      try {
        decoded = JSON.parse(result.stdout);
      } catch {
        throw new Error('[SEMANTIC_PROTOCOL] Expected one JSON response');
      }
      const vectors = (decoded as { vectors?: unknown })?.vectors;
      if (!Array.isArray(vectors) || vectors.length !== inputs.length)
        throw new Error('[SEMANTIC_PROTOCOL] Vector count mismatch');
      if (createLocalMultimodalEmbeddingProvider(options).identity !== identity)
        throw new Error('[SEMANTIC_MODEL] Model changed during inference');
      return vectors.map((v) => vector(v));
    },
  };
}

export async function indexMedia(
  options: SemanticIndexOptions,
  deps: { provider?: SemanticEmbeddingProvider; now?: () => number } = {}
): Promise<SemanticIndexReceipt> {
  const scope = validScope(options.scope, true);
  const output = indexPath(options.indexId, scope);
  if (
    !Array.isArray(options.entries) ||
    options.entries.length === 0 ||
    options.entries.length > MAX_ENTRIES
  )
    throw new Error('[SEMANTIC_INVALID] Index supports 1..512 entries');
  const ttl = options.ttlSeconds ?? 86400;
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 604800)
    throw new Error('[SEMANTIC_INVALID] ttlSeconds must be 1..604800');
  const provider = deps.provider ?? createLocalMultimodalEmbeddingProvider(options);
  boundedText(provider.identity, 'provider identity', 1024);
  const ids = new Set<string>();
  const versions = new Map<string, FileVersion>();
  const readVersion = (file: string): FileVersion => {
    let value = versions.get(file);
    if (!value) {
      value = version(file);
      versions.set(file, value);
    }
    return value;
  };
  const entries = options.entries.map((raw) => {
    const row = entry(raw);
    if (ids.has(row.id)) throw new Error('[SEMANTIC_INVALID] Duplicate entry id');
    ids.add(row.id);
    const file = sourcePath(row.path, scope);
    const image = row.image_path
      ? sourcePath(row.image_path, scope)
      : /\.(png|jpe?g|webp|bmp|gif)$/iu.test(file)
        ? file
        : undefined;
    if (!image && !row.text)
      throw new Error('[SEMANTIC_INVALID] Supply image_path or text for a non-image source');
    return {
      row,
      file,
      image,
      source: readVersion(file),
      ...(image ? { image_source: readVersion(image) } : {}),
    };
  });
  const rows: StoredEntry[] = [];
  let dimensions: number | undefined;
  for (let start = 0; start < entries.length; start += 16) {
    const batch = entries.slice(start, start + 16);
    const vectors = await provider.embed(
      batch.map((x) => (x.image ? { imagePath: x.image } : { text: x.row.text! }))
    );
    if (vectors.length !== batch.length)
      throw new Error('[SEMANTIC_PROTOCOL] Vector count mismatch');
    batch.forEach((item, i) => {
      const normalized = vector(vectors[i], dimensions);
      dimensions ??= normalized.length;
      const { image_path: _transientPath, ...reference } = item.row;
      rows.push({
        ...reference,
        vector: normalized,
        source: item.source,
        ...(item.image_source ? { image_sha256: item.image_source.sha256 } : {}),
      });
    });
  }
  for (const [file, expected] of versions) assertVersion(sourcePath(file, scope), expected);
  validScope(scope, true);
  const now = (deps.now ?? Date.now)();
  if (!finiteTime(now)) throw new Error('[SEMANTIC_INVALID] Clock');
  const stored: StoredIndex = {
    version: 1,
    scope,
    provider: provider.identity,
    dimensions: dimensions!,
    created_at: now,
    expires_at: now + ttl * 1000,
    entries: rows,
  };
  const serialized = JSON.stringify(stored, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > MAX_INDEX_BYTES)
    throw new Error('[SEMANTIC_INDEX] Encoded index exceeds 32 MiB; reduce entry count');
  writeJson(output, stored);
  return {
    index_id: options.indexId,
    entries: rows.length,
    provider: provider.identity,
    expires_at: new Date(stored.expires_at).toISOString(),
    index_path: path.relative(pathResolver.rootDir(), output),
  };
}

export async function searchMedia(
  options: SemanticSearchOptions,
  deps: { provider?: SemanticEmbeddingProvider; now?: () => number } = {}
): Promise<SemanticSearchHit[]> {
  const scope = validScope(options.scope, false);
  boundedText(options.query, 'query', 16384);
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('[SEMANTIC_INVALID] limit must be 1..100');
  const file = indexPath(options.indexId, scope);
  if (!safeExistsSync(file) || !safeLstat(file).isFile() || safeLstat(file).size > MAX_INDEX_BYTES)
    throw new Error('[SEMANTIC_INDEX] Missing or oversized index');
  const stored = decodeIndex(readJson<unknown>(file), scope);
  if ((deps.now ?? Date.now)() >= stored.expires_at)
    throw new Error('[SEMANTIC_EXPIRED] Rebuild the index');
  const provider = deps.provider ?? createLocalMultimodalEmbeddingProvider(options);
  if (provider.identity !== stored.provider)
    throw new Error('[SEMANTIC_MODEL] Index and query model revisions differ; rebuild index');
  const vectors = await provider.embed([{ text: options.query }]);
  if (vectors.length !== 1) throw new Error('[SEMANTIC_PROTOCOL] Query vector count');
  const query = vector(vectors[0], stored.dimensions);
  validScope(scope, false);
  const checked = new Set<string>();
  return stored.entries
    .map((row) => {
      const source = sourcePath(row.path, scope);
      if (!checked.has(source)) {
        assertVersion(source, row.source);
        checked.add(source);
      }
      return {
        ...entry(row),
        score: row.vector.reduce((sum, value, i) => sum + value * query[i]!, 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}
