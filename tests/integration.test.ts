import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rootDir = process.cwd();
const tmpDir = path.join(rootDir, 'tests', '_tmp_integration_ts');

// Load skill index
const skillIndex = JSON.parse(fs.readFileSync(path.join(rootDir, 'knowledge/orchestration/global_skill_index.json'), 'utf8'));
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
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Core Integration: Analysis -> Reporting', () => {
    it('should score quality and generate HTML report from markdown', () => {
      const md = '# Integration Test\n\nThis is a high quality document with significant technical detail and clear structure to ensure high quality scores.';
      const mdFile = path.join(tmpDir, 'test.md');
      const htmlFile = path.join(tmpDir, 'test.html');
      fs.writeFileSync(mdFile, md);

      // 1. Quality Scoring
      const quality = runSkill('quality-scorer', `-f "${mdFile}"`);
      expect(quality.data.score).toBeGreaterThan(0);

      // 2. HTML Reporting
      const report = runSkill('html-reporter', `-i "${mdFile}" -o "${htmlFile}" -t "Integration Test"`);
      expect(fs.existsSync(htmlFile)).toBe(true);
      const htmlContent = fs.readFileSync(htmlFile, 'utf8');
      expect(htmlContent).toContain('Integration Test');
      expect(htmlContent).toContain('high quality');
    });
  });

  describe('Chain 3: Code Analysis', () => {
    it('should detect language, encoding and check sensitivity', () => {
      const jsCode = '/** Test file */\nconst x = 1;\nmodule.exports = { x };';
      const jsFile = path.join(tmpDir, 'test.js');
      fs.writeFileSync(jsFile, jsCode);

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
