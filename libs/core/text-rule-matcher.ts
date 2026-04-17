export interface TextMatchClause {
  type: 'contains' | 'regex';
  value: string;
}

export interface TextMatchGroup {
  type: 'any';
  clauses: TextMatchClause[];
}

export type TextMatchRule = TextMatchClause | TextMatchGroup;

function normalizeRule(rule: TextMatchRule | string): TextMatchRule {
  if (typeof rule === 'string') {
    return { type: 'contains', value: rule };
  }
  return rule;
}

export function matchesTextRule(text: string, rule: TextMatchRule | string): boolean {
  const normalized = normalizeRule(rule);
  if (normalized.type === 'any') {
    return normalized.clauses.some((clause) => matchesTextRule(text, clause));
  }
  if (normalized.type === 'regex') {
    return new RegExp(normalized.value, 'i').test(text);
  }
  return text.toLowerCase().includes(normalized.value.toLowerCase());
}

export function matchesAnyTextRule(text: string, rules: Array<TextMatchRule | string> | undefined): boolean {
  if (!rules?.length) return false;
  return rules.some((rule) => matchesTextRule(text, rule));
}
