export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface OptimizationResult {
  file: string;
  score: number;
  maxScore: number;
  percentage: number;
  checks: CheckResult[];
  suggestions: string[];
}

const REQUIRED_SECTIONS = ['Usage', 'Troubleshooting', 'Options'];

const CLARITY_INDICATORS = [
  'must',
  'should',
  'returns',
  'outputs',
  'requires',
  'provides',
  'accepts',
  'generates',
  'validates',
  'ensures',
];

const ACTIONABLE_PATTERNS = [
  new RegExp('\\b(run|execute|call|invoke|use|pass|specify|provide|set|configure)\\b', 'i'),
];

const VAGUE_WORDS = [
  'stuff',
  'things',
  'somehow',
  'maybe',
  'possibly',
  'etc',
  'various',
  'certain',
  'some kind of',
  'sort of',
];

export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(new RegExp('^---\\s*\\n([\\s\\S]*?)\\n---'));
  if (!match) return {};
  const fm: Record<string, string> = {};
  const lines = match[1].split(new RegExp('\\r?\\n'));
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      fm[key] = value;
    }
  }
  return fm;
}

export function hasSection(content: string, sectionName: string): boolean {
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^##\\s+${escapedName}`, 'm');
  return pattern.test(content);
}

export function getBody(content: string): string {
  const match = content.match(new RegExp('^---\\s*\\n[\\s\\S]*?\\n---\\s*\\n([\\s\\S]*)'));
  return match ? match[1] : content;
}

export function optimizePrompt(content: string, filePath: string): OptimizationResult {
  const frontmatter = parseFrontmatter(content);
  const body = getBody(content);
  const checks: CheckResult[] = [];
  const suggestions: string[] = [];

  // Check 1: Has valid frontmatter with name
  const hasFrontmatterName = !!frontmatter.name;
  checks.push({
    name: 'frontmatter-name',
    passed: hasFrontmatterName,
    detail: hasFrontmatterName
      ? `Name: "${frontmatter.name}"`
      : 'Missing "name" field in frontmatter',
  });
  if (!hasFrontmatterName) {
    suggestions.push('Add a "name" field to the YAML frontmatter (e.g., name: my-skill).');
  }

  // Check 2: Has valid frontmatter with description
  const hasFrontmatterDesc = !!frontmatter.description;
  checks.push({
    name: 'frontmatter-description',
    passed: hasFrontmatterDesc,
    detail: hasFrontmatterDesc
      ? `Description length: ${frontmatter.description.length} chars`
      : 'Missing "description" field in frontmatter',
  });
  if (!hasFrontmatterDesc) {
    suggestions.push('Add a "description" field to the YAML frontmatter.');
  }

  // Check 3: Description length
  const descLength = (frontmatter.description || '').length;
  const descLengthOk = descLength >= 20 && descLength <= 200;
  checks.push({
    name: 'description-length',
    passed: descLengthOk,
    detail:
      descLength > 0
        ? `Description is ${descLength} chars (ideal: 20-200)`
        : 'No description to evaluate',
  });
  if (descLength > 0 && descLength < 20)
    suggestions.push('Expand the description to at least 20 characters.');
  if (descLength > 200) suggestions.push('Shorten the description to 200 characters or less.');

  // Check 4-6: Required sections
  for (const section of REQUIRED_SECTIONS) {
    const found = hasSection(content, section);
    checks.push({
      name: `section-${section.toLowerCase()}`,
      passed: found,
      detail: found ? `"## ${section}" section found` : `Missing "## ${section}" section`,
    });
    if (!found) suggestions.push(`Add a "## ${section}" section.`);
  }

  // Check 7: Clarity indicators
  const clarityCount = CLARITY_INDICATORS.filter((word) => {
    const pattern = new RegExp(`\\b${word}\\b`, 'i');
    return pattern.test(body);
  }).length;
  const hasClarityIndicators = clarityCount >= 3;
  checks.push({
    name: 'clarity-indicators',
    passed: hasClarityIndicators,
    detail: `Found ${clarityCount}/${CLARITY_INDICATORS.length} clarity indicators (need at least 3)`,
  });

  // Check 8: Actionable language
  const actionableCount = ACTIONABLE_PATTERNS.filter((pattern) => pattern.test(body)).length;
  const hasActionableLanguage = actionableCount > 0;
  checks.push({
    name: 'actionable-language',
    passed: hasActionableLanguage,
    detail: hasActionableLanguage
      ? `Found actionable language patterns (${actionableCount})`
      : 'No actionable verb patterns found',
  });

  // Check 9: No vague words
  const vagueFound = VAGUE_WORDS.filter((word) => {
    const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escapedWord}\\b`, 'i');
    return pattern.test(body);
  });
  const noVagueWords = vagueFound.length === 0;
  checks.push({
    name: 'no-vague-words',
    passed: noVagueWords,
    detail: noVagueWords
      ? 'No vague language detected'
      : `Found vague words: ${vagueFound.join(', ')}`,
  });

  // Check 10: Knowledge Protocol
  const hasKnowledgeProtocol = new RegExp('knowledge\\s*protocol', 'i').test(content);
  checks.push({
    name: 'knowledge-protocol',
    passed: hasKnowledgeProtocol,
    detail: hasKnowledgeProtocol
      ? 'Knowledge Protocol reference found'
      : 'No Knowledge Protocol reference found',
  });

  // Check 11: Has examples
  const hasExamples =
    new RegExp('```[\\s\\S]*?```').test(body) ||
    new RegExp('^\\s*[-*]\\s+"[^"]+"', 'm').test(body) ||
    new RegExp('^\\s*[-*]\\s+`[^`]+`', 'm').test(body);
  checks.push({
    name: 'has-examples',
    passed: hasExamples,
    detail: hasExamples ? 'Usage examples found' : 'No concrete examples found',
  });

  // Check 12: Sufficient content
  const bodyLength = body.trim().length;
  const sufficientContent = bodyLength >= 100;
  checks.push({
    name: 'sufficient-content',
    passed: sufficientContent,
    detail: `Body content: ${bodyLength} chars (minimum: 100)`,
  });

  const score = checks.filter((c) => c.passed).length;
  const maxScore = checks.length;

  return {
    file: filePath,
    score,
    maxScore,
    percentage: Math.round((score / maxScore) * 100),
    checks,
    suggestions,
  };
}
