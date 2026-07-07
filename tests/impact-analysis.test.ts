import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * E2E-06 Task 6: impact_analysis produces a schema-shaped statement of how a
 * change request touches existing assets (files/summary/risks/size).
 */

const backendPrompt = vi.hoisted(() => vi.fn());
vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getReasoningBackend: () => ({ prompt: backendPrompt }),
  };
});

import { impactAnalysisOp } from '../libs/actuators/code-actuator/src/code-pipeline-helpers.js';

describe('impact_analysis (E2E-06 Task 6)', () => {
  let repoDir: string;

  beforeAll(() => {
    repoDir = path.resolve(__dirname, '..', 'active', 'shared', 'tmp', `impact-${randomUUID()}`);
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'auth.ts'), 'export const login = () => {};');
    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const app = () => {};');
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns a validated impact-analysis object and writes the artifact', async () => {
    backendPrompt.mockResolvedValue(
      JSON.stringify({
        summary: 'ログイン機能の変更は auth.ts に集中する',
        files: [{ path: 'src/auth.ts', change: '2FA 分岐を追加' }],
        risks: ['セッション互換性'],
        size: 'M',
      })
    );
    const outputPath = path.join(repoDir, 'impact-analysis.json');
    const result = await impactAnalysisOp({
      repo_path: repoDir,
      requirements: { summary: 'ログインに 2FA を追加したい' },
      output_path: outputPath,
    });
    expect(result.kind).toBe('impact-analysis');
    expect(result.size).toBe('M');
    expect(result.files).toEqual([{ path: 'src/auth.ts', change: '2FA 分岐を追加' }]);
    expect(result.risks).toEqual(['セッション互換性']);
    expect(fs.existsSync(outputPath)).toBe(true);

    // the prompt carries the deterministic file inventory
    const prompt = backendPrompt.mock.calls[0][0] as string;
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('src/app.ts');
    expect(prompt).toContain('2FA');
  });

  it('rejects non-JSON backend output instead of guessing', async () => {
    backendPrompt.mockResolvedValue('わかりません');
    await expect(impactAnalysisOp({ repo_path: repoDir, requirements: 'x' })).rejects.toThrow(
      /did not return JSON/
    );
  });

  it('requires repo_path and requirements', async () => {
    await expect(impactAnalysisOp({ repo_path: '', requirements: 'x' })).rejects.toThrow(
      /repo_path/
    );
    await expect(
      impactAnalysisOp({ repo_path: repoDir, requirements: undefined as unknown as string })
    ).rejects.toThrow(/requirements/);
  });
});
