import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { resolveStorageFloor } from '../storage-layout.js';
import {
  indexMedia,
  searchMedia,
  createLocalMultimodalEmbeddingProvider,
  type SemanticEmbeddingProvider,
  type SemanticScope,
} from './semantic-index.js';
const authority = vi.hoisted(() => ({
  scope: { tier: 'public' as string, tenant_slug: undefined as string | undefined },
}));
vi.mock('../scope-context.js', () => ({ currentScope: () => authority.scope }));
vi.mock('../scope-envelope.js', () => ({ currentScopeEnvelope: () => undefined }));
const files: string[] = [];
function source(name = 'image.png'): string {
  const file = pathResolver.sharedTmp('semantic-tests/' + randomUUID() + '-' + name);
  safeWriteFile(file, 'fixture pixels');
  files.push(file);
  return file;
}
function id(): string {
  const value = 'semantic-test-' + randomUUID();
  files.push(
    resolveStorageFloor(
      'cache',
      { kind: 'tier', tier: 'public' },
      'perception',
      'semantic',
      value + '.json'
    )
  );
  return value;
}
const scope: SemanticScope = { tier: 'public' };
const provider: SemanticEmbeddingProvider = {
  identity: 'fixture-semantic:revision-a',
  embed: vi.fn(async (inputs) =>
    inputs.map((input) => ('text' in input ? [1, 0, 0] : [0.9, 0.1, 0]))
  ),
};
afterEach(() => {
  files.splice(0).forEach((file) => safeRmSync(file, { force: true, recursive: true }));
  authority.scope = { tier: 'public', tenant_slug: undefined };
  vi.clearAllMocks();
});

describe('scoped semantic media index', () => {
  it('indexes image vectors and searches text in the same semantic space with source/time refs', async () => {
    const indexId = id();
    const file = source();
    const sourceVideo = source('video.mp4');
    const receipt = await indexMedia(
      {
        indexId,
        scope,
        modelPath: 'unused',
        entries: [{ id: 'scene-1', path: sourceVideo, image_path: file, time_sec: 4.2 }],
      },
      { provider, now: () => 1000 }
    );
    const hits = await searchMedia(
      { indexId, scope, modelPath: 'unused', query: 'the red slide' },
      { provider, now: () => 2000 }
    );
    expect(receipt.entries).toBe(1);
    expect(receipt.provider).toBe(provider.identity);
    safeRmSync(file, { force: true });
    expect(hits[0]).toMatchObject({ id: 'scene-1', path: sourceVideo, time_sec: 4.2 });
    expect(hits[0]).not.toHaveProperty('image_path');
    await expect(
      searchMedia(
        { indexId, scope, modelPath: 'unused', query: 'red' },
        { provider, now: () => 2000 }
      )
    ).resolves.toHaveLength(1);
    expect(hits[0]!.score).toBeGreaterThan(0.99);
    expect(hits[0]).not.toHaveProperty('vector');
  });
  it('refuses self asserted tier/tenant before invoking a model', async () => {
    await expect(
      indexMedia(
        {
          indexId: id(),
          scope: { tier: 'confidential', tenant_slug: 'acme' },
          entries: [{ id: 'x', path: source() }],
          modelPath: 'unused',
        },
        { provider }
      )
    ).rejects.toThrow('runtime scope');
    expect(provider.embed).not.toHaveBeenCalled();
    authority.scope = { tier: 'confidential', tenant_slug: 'acme' };
    await expect(
      searchMedia(
        {
          indexId: 'x',
          scope: { tier: 'confidential', tenant_slug: 'other' },
          query: 'x',
          modelPath: 'unused',
        },
        { provider }
      )
    ).rejects.toThrow('runtime scope');
  });
  it('refuses a private physical source path in a public index', async () => {
    const privateSource = pathResolver.rootResolve(
      'active/shared/tmp/confidential/acme/semantic-tests/' + randomUUID() + '.png'
    );
    safeWriteFile(privateSource, 'secret');
    files.push(privateSource);
    await expect(
      indexMedia(
        { indexId: id(), scope, modelPath: 'unused', entries: [{ id: 'x', path: privateSource }] },
        { provider }
      )
    ).rejects.toThrow('tier');
  });
  it('refuses cross-tenant source even when runtime tenant is valid', async () => {
    authority.scope = { tier: 'confidential', tenant_slug: 'acme' };
    const foreign = pathResolver.rootResolve(
      'active/shared/tmp/confidential/other/semantic-tests/' + randomUUID() + '.png'
    );
    safeWriteFile(foreign, 'secret');
    files.push(foreign);
    await expect(
      indexMedia(
        {
          indexId: 'test',
          scope: { tier: 'confidential', tenant_slug: 'acme' },
          modelPath: 'unused',
          entries: [{ id: 'x', path: foreign }],
        },
        { provider }
      )
    ).rejects.toThrow('tenant');
  });
  it('expires indexes and rejects incompatible model revisions', async () => {
    const indexId = id();
    await indexMedia(
      {
        indexId,
        scope,
        modelPath: 'unused',
        ttlSeconds: 1,
        entries: [{ id: 'x', path: source() }],
      },
      { provider, now: () => 1000 }
    );
    await expect(
      searchMedia(
        { indexId, scope, modelPath: 'unused', query: 'x' },
        { provider, now: () => 2000 }
      )
    ).rejects.toThrow('EXPIRED');
    await expect(
      searchMedia(
        { indexId, scope, modelPath: 'unused', query: 'x' },
        { provider: { ...provider, identity: 'different' }, now: () => 1001 }
      )
    ).rejects.toThrow('revisions differ');
  });
  it('rejects malformed vectors and mismatched dimensions', async () => {
    const input = {
      indexId: id(),
      scope,
      modelPath: 'unused',
      entries: [
        { id: 'a', path: source() },
        { id: 'b', path: source() },
      ],
    };
    for (const vectors of [
      [
        [NaN, 1],
        [1, 2],
      ],
      [
        [0, 0],
        [1, 2],
      ],
      [
        [1, 2],
        [1, 2, 3],
      ],
      [[1, 2]],
    ]) {
      await expect(
        indexMedia(input, { provider: { identity: 'x', embed: async () => vectors } })
      ).rejects.toThrow(/VECTOR|PROTOCOL/);
    }
  });
  it('refuses stale sources and image frames at query time', async () => {
    const indexId = id();
    const file = source();
    await indexMedia(
      { indexId, scope, modelPath: 'unused', entries: [{ id: 'x', path: file }] },
      { provider }
    );
    safeWriteFile(file, 'changed pixels with longer contents');
    await expect(
      searchMedia({ indexId, scope, modelPath: 'unused', query: 'x' }, { provider })
    ).rejects.toThrow('STALE');
  });
  it('validates stored metadata, duplicate IDs and vector dimensions rather than trusting cache JSON', async () => {
    const indexId = id();
    const receipt = await indexMedia(
      { indexId, scope, modelPath: 'unused', entries: [{ id: 'x', path: source() }] },
      { provider }
    );
    const file = pathResolver.rootResolve(receipt.index_path);
    const stored = JSON.parse(String(safeReadFile(file)));
    stored.entries[0].vector = [1, 0];
    safeWriteFile(file, JSON.stringify(stored));
    await expect(
      searchMedia({ indexId, scope, modelPath: 'unused', query: 'x' }, { provider })
    ).rejects.toThrow('VECTOR');
  });
  it('refuses traversal, excessive batches, empty input and malformed time ranges', async () => {
    const base = {
      indexId: id(),
      scope,
      modelPath: 'unused',
      entries: [{ id: 'x', path: source() }],
    };
    await expect(indexMedia({ ...base, indexId: '../escape' }, { provider })).rejects.toThrow(
      'indexId'
    );
    await expect(indexMedia({ ...base, entries: [] }, { provider })).rejects.toThrow('1..512');
    await expect(
      indexMedia(
        {
          ...base,
          entries: Array.from({ length: 513 }, (_, i) => ({
            id: String(i),
            path: base.entries[0]!.path,
          })),
        },
        { provider }
      )
    ).rejects.toThrow('1..512');
    await expect(
      indexMedia(
        { ...base, entries: [{ ...base.entries[0]!, time_sec: 10, end_sec: 5 }] },
        { provider }
      )
    ).rejects.toThrow('Inverted');
    await expect(
      indexMedia({ ...base, entries: [base.entries[0]!, base.entries[0]!] }, { provider })
    ).rejects.toThrow('Duplicate');
    await expect(
      indexMedia({ ...base, entries: [{ id: 'text', path: source('audio.wav') }] }, { provider })
    ).rejects.toThrow('image_path or text');
  });
  it('requires local built-in models with safetensors and refuses external model ids', () => {
    expect(() => createLocalMultimodalEmbeddingProvider({ modelPath: '../outside' })).toThrow();
    const dir = path.dirname(source('model/config.json'));
    files.push(dir);
    safeWriteFile(path.join(dir, 'config.json'), '{"model_type":"unknown"}');
    expect(() => createLocalMultimodalEmbeddingProvider({ modelPath: dir })).toThrow(
      'CLIP or SigLIP'
    );
    safeWriteFile(path.join(dir, 'config.json'), '{"model_type":"clip"}');
    expect(() => createLocalMultimodalEmbeddingProvider({ modelPath: dir })).toThrow('safetensors');
  });
});
