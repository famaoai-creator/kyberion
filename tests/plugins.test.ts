import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rootDir = process.cwd();
const scratchDir = path.join(rootDir, 'scratch');

describe('Plugin System Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(scratchDir, 'plugin-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should call beforeSkill and afterSkill hooks during skill execution', () => {
    const inputFile = path.join(tmpDir, 'test.json');
    fs.writeFileSync(inputFile, JSON.stringify({ hello: 'world' }));

    const markerFile = path.join(tmpDir, 'hook-markers.json');
    const pluginFile = path.join(tmpDir, 'test-plugin.cjs');
    
    // Create a legacy CJS plugin
    fs.writeFileSync(pluginFile, `
      const fs = require('fs');
      module.exports = {
        beforeSkill(name) {
          const m = fs.existsSync('${markerFile}') ? JSON.parse(fs.readFileSync('${markerFile}')) : { before: [] };
          m.before.push(name);
          fs.writeFileSync('${markerFile}', JSON.stringify(m));
        },
        afterSkill(name, out) {
          const m = fs.existsSync('${markerFile}') ? JSON.parse(fs.readFileSync('${markerFile}')) : { after: [] };
          m.after = m.after || [];
          m.after.push({ name, status: out.status });
          fs.writeFileSync('${markerFile}', JSON.stringify(m));
        }
      };
    `);

    const configFile = path.join(tmpDir, '.kyberion-plugins.json');
    fs.writeFileSync(configFile, JSON.stringify({ plugins: [pluginFile] }));

    const skillScript = path.join(rootDir, 'skills/utilities/format-detector/dist/index.js');

    // We must pass KYBERION_HOME or ensure .kyberion-plugins.json is found in CWD
    execSync(`node "${skillScript}" -i "${inputFile}"`, {
      cwd: tmpDir,
      env: { ...process.env, NODE_ENV: 'production', KYBERION_HOME: tmpDir }
    });

    expect(fs.existsSync(markerFile)).toBe(true);
    const markers = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    expect(markers.before).toContain('format-detector');
    expect(markers.after[0].name).toBe('format-detector');
    expect(markers.after[0].status).toBe('success');
  });
});
