/**
 * OH-04 offload semantics + AL-02 mission-local placement.
 *
 * Hermetic: a temp KYBERION_ROOT is set BEFORE importing any repo module
 * (path-resolver binds its project root at import time), so offloads land in
 * a throwaway tree instead of the real active/. Raw fs seeds/inspects the
 * temp root (registered in tests/core-fs-exception-boundary.test.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmpRoot: string;
let mod: typeof import('./output-artifacts.js');

/** secure-io's policy engine fails closed without policies — seed the real file. */
function seedPolicyFile(root: string): void {
  const target = path.join(root, 'knowledge', 'product', 'governance', 'agent-policies.yaml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'knowledge/product/governance/agent-policies.yaml'), target);
}

describe('output-artifacts', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyb-output-artifacts-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    seedPolicyFile(tmpRoot);
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.MISSION_ROLE = 'mission_controller';
    mod = await import('./output-artifacts.js');
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    delete process.env.MISSION_ROLE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('keeps small output inline', () => {
    expect(mod.offloadLargeOutput('small', { maxInlineChars: 10 })).toBeNull();
  });

  it('AL-02: offloads mission-known output to the mission-local cache artifacts area', () => {
    const body = 'x'.repeat(mod.DEFAULT_INLINE_OUTPUT_CHARS + 100);
    const recordArtifact = vi.fn();
    const reference = mod.offloadLargeOutput(body, {
      stepOp: 'system:exec',
      stepNumber: 3,
      missionId: 'mission-oh04-test',
      recordArtifact,
    });

    expect(reference).toMatchObject({
      truncated: true,
      chars: body.length,
      media_type: 'text/plain',
    });
    expect(reference?.preview.length).toBeLessThan(body.length);
    expect(reference?.artifact_path).toMatch(
      /^active\/missions\/mission-oh04-test\/artifacts\/cache\/tool-output\/3-system-exec-/
    );
    const absolute = path.join(tmpRoot, reference!.artifact_path);
    expect(fs.readFileSync(absolute, 'utf8')).toBe(body);
    expect(recordArtifact).toHaveBeenCalledWith(
      reference?.artifact_path,
      expect.stringContaining('system:exec')
    );

    // The offload is recorded in the mission's artifacts index as class 'cache'
    // so mission-finish GC (AL-03) can reclaim it without stat-walking.
    const indexPath = path.join(
      tmpRoot,
      'active/missions/mission-oh04-test/artifacts/artifacts-index.jsonl'
    );
    const entries = fs
      .readFileSync(indexPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      entries.some((e) => e.path === reference?.artifact_path && e.artifact_class === 'cache')
    ).toBe(true);
  });

  it('falls back to shared tmp when the mission is unknown', () => {
    const body = 'y'.repeat(mod.DEFAULT_INLINE_OUTPUT_CHARS + 100);
    const reference = mod.offloadLargeOutput(body, {
      stepOp: 'system:exec',
      stepNumber: 1,
    });

    expect(reference?.artifact_path).toMatch(/^active\/shared\/tmp\/tool-output\/shared\//);
    expect(fs.readFileSync(path.join(tmpRoot, reference!.artifact_path), 'utf8')).toBe(body);
  });

  it("treats the 'shared' mission slug as mission-unknown (run_pipeline default)", () => {
    const body = 'z'.repeat(300);
    const reference = mod.offloadLargeOutput(body, {
      maxInlineChars: 100,
      missionId: 'shared',
      stepOp: 'system:exec',
    });
    expect(reference?.artifact_path).toMatch(/^active\/shared\/tmp\/tool-output\/shared\//);
  });

  it('OH-04 regression: compacts only the exported step channel', () => {
    const body = 'y'.repeat(300);
    const context = { input: body, exec_result: body };
    const compacted = mod.compactStepOutputContext(context, ['exec_result'], {
      maxInlineChars: 100,
      stepOp: 'system:exec',
    });

    expect(compacted.input).toBe(body);
    expect(compacted.exec_result).toMatchObject({ truncated: true });
  });

  it('OH-04 regression: leaves existing artifact references untouched', () => {
    const existing = { artifact_path: 'active/shared/tmp/tool-output/prior.log', truncated: true };
    const compacted = mod.compactStepOutputContext({ exec_result: existing }, ['exec_result'], {
      maxInlineChars: 100,
    });
    expect(compacted.exec_result).toBe(existing);
  });
});
