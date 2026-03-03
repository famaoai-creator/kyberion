import { classifier, KnowledgeProvider, safeReadFile } from '@agent/core';

export interface ClassifierRules {
  resultKey: string;
  categories: Record<string, string[]>;
}

export function classifyText(filePath: string, ruleSet: 'doc-type' | 'domain' | 'intent') {
  const rules = KnowledgeProvider.getJson<ClassifierRules>(`skills/utilities/${ruleSet}-classifier/rules.json`, {
    resultKey: ruleSet,
    categories: {}
  });

  return (classifier as any).classifyFile(filePath, rules.categories, {
    resultKey: rules.resultKey,
  });
}
