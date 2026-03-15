import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../libs/core/index.js';

const rootDir = process.cwd();
const tmpDir = path.join(rootDir, 'scratch', '_tmp_integration_ts');

// Load skill index
const skillIndex = JSON.parse(
  safeReadFile(path.join(rootDir, 'knowledge/public/orchestration/global_skill_index.json'), { encoding: 'utf8' }) as string
);
const skillMap: Record<string, string> = {};
skillIndex.s.forEach((s: any) => {
  skillMap[s.n] = path.join(s.path, s.m || 'dist/index.js');
});

function runSkill(name: string, args: string) {
  const skillPath = skillMap[name];
  if (!skillPath) throw new Error(`Skill not found in index: ${name}`);
  const cmd = `node "${path.join(rootDir, skillPath)}" ${args}`;
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', cwd: rootDir, timeout: 30000 });
    const envelope = JSON.parse(stdout);
    if (envelope.status !== 'success') {
      throw new Error(`Skill ${name} reported error: ${JSON.stringify(envelope.error)}`);
    }
    return envelope;
  } catch (err: any) {
    console.error(`Execution failed for ${name}:`, err.stdout || err.message);
    throw err;
  }
}

describe('E2E Skill Chains (Integration)', () => {
  beforeEach(() => {
    process.env.MISSION_ROLE = 'ecosystem_architect';
    if (!safeExistsSync(tmpDir)) {
      safeMkdir(tmpDir, { recursive: true });
    }
  });

  afterAll(() => {
    process.env.MISSION_ROLE = 'ecosystem_architect';
    if (safeExistsSync(tmpDir)) {
      safeRmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Core Integration: Analysis -> Reporting', () => {
    it('should score quality and generate HTML report from markdown', () => {
      const md = '# Integration Test\n\nThis is a high quality document with significant technical detail and clear structure to ensure high quality scores.';
      const mdFile = path.join(tmpDir, 'test.md');
      const htmlFile = path.join(tmpDir, 'test.html');
      safeWriteFile(mdFile, md);

      // 1. Quality Scoring
      const quality = runSkill('quality-scorer', `-f "${mdFile}"`);
      expect(quality.data.score).toBeGreaterThan(0);

      // 2. HTML Reporting
      const report = runSkill('html-reporter', `-i "${mdFile}" -o "${htmlFile}" -t "Integration Test"`);
      expect(safeExistsSync(htmlFile)).toBe(true);
      const htmlContent = safeReadFile(htmlFile, { encoding: 'utf8' }) as string;
      expect(htmlContent).toContain('Integration Test');
      expect(htmlContent).toContain('high quality');
    });
  });

  describe('Chain 3: Code Analysis', () => {
    it('should detect language, encoding and check sensitivity', () => {
      const jsCode = '/** Test file */\nconst x = 1;\nmodule.exports = { x };';
      const jsFile = path.join(tmpDir, 'test.js');
      safeWriteFile(jsFile, jsCode);

      // 1. Language Detection
      const lang = runSkill('code-lang-detector', `-i "${jsFile}"`);
      expect(lang.data.lang).toBe('javascript');

      // 2. Encoding Detection
      const encoding = runSkill('encoding-detector', `-i "${jsFile}"`);
      expect(encoding.data.encoding).toBeDefined();

      // 3. Sensitivity Detection
      const sensitivity = runSkill('sensitivity-detector', `-i "${jsFile}"`);
      expect(sensitivity.data.hasPII).toBe(false);
    });
  });
});
