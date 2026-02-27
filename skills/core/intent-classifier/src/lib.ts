import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { classifyFile } from '@agent/core/classifier';

export interface IntentRules {
  resultKey: string;
  categories: Record<string, string[]>;
}

export function loadRules(rulesPath: string): IntentRules {
  if (!fs.existsSync(rulesPath)) {
    throw new Error(`Rules file not found: ${rulesPath}`);
  }
  const content = safeReadFile(rulesPath, 'utf8');
  return yaml.load(content) as IntentRules;
}

export function classifyIntent(filePath: string, rules: IntentRules) {
  return classifyFile(filePath, rules.categories, { resultKey: rules.resultKey });
}
