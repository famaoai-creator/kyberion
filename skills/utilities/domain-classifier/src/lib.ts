import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import yaml from 'js-yaml';
import { classifyFile } from '@agent/core/classifier';

export interface DomainRules {
  resultKey: string;
  categories: Record<string, string[]>;
}

export function loadDomainRules(rulesPath: string): DomainRules {
  const fs = require('node:fs');
  const content = safeReadFile(rulesPath, 'utf8');
  return yaml.load(content) as DomainRules;
}

export function classifyDomain(filePath: string, rules: DomainRules) {
  return classifyFile(filePath, rules.categories, { resultKey: rules.resultKey });
}
