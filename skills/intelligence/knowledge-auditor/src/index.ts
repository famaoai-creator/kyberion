import * as fs from 'node:fs';
import * as path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import { performAudit, AuditConfig } from './lib.js';

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    default: 'knowledge',
    description: 'Knowledge directory to audit',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output path for audit report',
  })
  .help()
  .parseSync();

runSkill('knowledge-auditor', () => {
  const targetDir = path.resolve(argv.input as string);
  if (!fs.existsSync(targetDir)) throw new Error('Directory not found: ' + targetDir);

  // Dynamic config with defaults
  const defaultConfig: AuditConfig = {
    audit_name: 'Knowledge Audit',
    exclusions: ['.git', 'node_modules'],
    severity_mapping: {
      personal_leak: 'critical',
    },
  };

  const configPath = path.resolve('knowledge/skills/knowledge-auditor/config.json');
  let config = defaultConfig;
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {}
  }

  const result = performAudit(targetDir, config);

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
