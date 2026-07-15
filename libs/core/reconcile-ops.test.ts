import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureIo = vi.hoisted(() => ({
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
}));

vi.mock('./secure-io.js', () => secureIo);

describe('reconcile ops (LE-03)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-reconcile-${randomUUID()}`);
    fs.mkdirSync(path.join(tmpRoot, 'active', 'shared', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('reconcileConfigFallbacks returns an empty result on a missing registry', async () => {
    const { reconcileConfigFallbacks } = await import('./reconcile-ops.js');
    expect(reconcileConfigFallbacks()).toEqual({
      repaired: [],
      proposals_written: [],
      skipped: [],
      pruned: 0,
    });
  });

  it('reconcileConfigFallbacks creates public-tier files and skips other tiers', async () => {
    const registry = {
      version: '1.0.0',
      entries: [
        {
          knowledge_path: 'public/demo/le03-sample.json',
          first_seen: '2026-07-15T00:00:00.000Z',
          last_seen: '2026-07-15T00:00:00.000Z',
          occurrence_count: 1,
          last_error: 'ENOENT',
          reason: 'file_not_found',
          defaults_snapshot: { hello: 'world' },
          resolved: false,
        },
        {
          knowledge_path: 'confidential/tenant/secret.json',
          first_seen: '2026-07-15T00:00:00.000Z',
          last_seen: '2026-07-15T00:00:00.000Z',
          occurrence_count: 1,
          last_error: 'ENOENT',
          reason: 'file_not_found',
          defaults_snapshot: {},
          resolved: false,
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpRoot, 'active', 'shared', 'tmp', 'config-fallback-registry.json'),
      JSON.stringify(registry)
    );

    const { reconcileConfigFallbacks } = await import('./reconcile-ops.js');
    const result = reconcileConfigFallbacks();

    expect(result.repaired).toEqual([
      { knowledge_path: 'public/demo/le03-sample.json', action: 'created from defaults_snapshot' },
    ]);
    expect(result.skipped).toEqual([
      {
        knowledge_path: 'confidential/tenant/secret.json',
        reason: 'not in public/ tier — auto-create skipped for safety',
      },
    ]);
    const created = path.join(tmpRoot, 'knowledge', 'public', 'demo', 'le03-sample.json');
    expect(JSON.parse(fs.readFileSync(created, 'utf8'))).toEqual({ hello: 'world' });
  });

  it('reconcileUnclassifiedErrors writes a proposal stub per unreconciled entry', async () => {
    const registry = {
      version: '1.0.0',
      entries: [
        {
          message_excerpt: 'Totally novel failure mode',
          occurrence_count: 3,
          first_seen: '2026-07-15T00:00:00.000Z',
          last_seen: '2026-07-15T00:00:00.000Z',
          reconciled: false,
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpRoot, 'active', 'shared', 'tmp', 'unclassified-error-registry.json'),
      JSON.stringify(registry)
    );

    const { reconcileUnclassifiedErrors } = await import('./reconcile-ops.js');
    const result = reconcileUnclassifiedErrors();

    expect(result.total_unreconciled).toBe(1);
    expect(result.proposals_written).toHaveLength(1);
    const proposalPath = path.join(tmpRoot, result.proposals_written[0].proposal_path);
    const proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
    expect(proposal.suggested_rule.patterns).toHaveLength(1);
  });

  it('reconcileUnhandledIntents produces summary_line and proposal stubs', async () => {
    const registry = {
      version: '1.0.0',
      entries: [
        {
          miss_type: 'unrouted',
          intent_id: 'demo.intent',
          shape: 'pipeline',
          utterance_samples: ['run the demo'],
          occurrence_count: 2,
          first_seen: '2026-07-15T00:00:00.000Z',
          last_seen: '2026-07-15T00:00:00.000Z',
          reconciled: false,
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpRoot, 'active', 'shared', 'tmp', 'unhandled-intent-registry.json'),
      JSON.stringify(registry)
    );

    const { reconcileUnhandledIntents } = await import('./reconcile-ops.js');
    const result = reconcileUnhandledIntents();

    expect(result.total_unreconciled).toBe(1);
    expect(result.summary_line).toContain('demo.intent');
    expect(result.top_unreconciled?.key).toBe('demo.intent');
    expect(result.proposals_written[0].miss_type).toBe('unrouted');
    const summary = fs.readFileSync(
      path.join(tmpRoot, 'active', 'shared', 'tmp', 'unhandled-intent-last-run.summary.txt'),
      'utf8'
    );
    expect(summary).toContain('unreconciled=1');
  });
});
