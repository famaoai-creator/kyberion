import * as path from 'path';

export const LANG_DETECTION: Record<string, string> = {
  '.js': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
};

export const IDIOM_MAP: Record<
  string,
  Array<{ from: RegExp; to: string | ((m: string) => string) }>
> = {
  'javascript->python': [
    { from: /const\s+(\w+)\s*=\s*/g, to: '$1 = ' },
    { from: /let\s+(\w+)\s*=\s*/g, to: '$1 = ' },
    { from: /function\s+(\w+)\s*\((.*?)\)\s*\{/g, to: 'def $1($2):' },
    { from: /console\.log/g, to: 'print' },
    { from: /===|!==/g, to: (m: string) => (m === '===' ? '==' : '!=') },
    {
      from: /\bfor\s*\(\s*(?:let|const|var)\s+(\w+)\s*=\s*0;\s*\1\s*<\s*(\w+)(?:\.length)?;\s*\1\+\+\s*\)/g,
      to: 'for $1 in range($2)',
    },
  ],
  'javascript->go': [
    { from: /const\s+(\w+)\s*=\s*/g, to: '$1 := ' },
    { from: /function\s+(\w+)\s*\((.*?)\)\s*\{/g, to: 'func $1($2) {' },
    { from: /console\.log/g, to: 'fmt.Println' },
  ],
};

export interface SourceAnalysis {
  lines: number;
  functions: number;
  classes: number;
  imports: number;
  complexity: 'low' | 'medium' | 'high';
}

export interface MigrationEstimate {
  idiomRulesAvailable: number;
  estimatedEffort: string;
  manualReviewRequired: string[];
  automatable: string;
}

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANG_DETECTION[ext] || 'unknown';
}

export function analyzeSource(content: string, language: string): SourceAnalysis {
  const lines = content.split(new RegExp('\\r?\\n')).length;
  const analysis: SourceAnalysis = {
    lines,
    functions: 0,
    classes: 0,
    imports: 0,
    complexity: 'low',
  };

  if (language === 'javascript' || language === 'typescript') {
    analysis.functions = (
      content.match(/(?:function\s+\w+|const\s+\w+\s*=\s*(?:\(|async))/g) || []
    ).length;
    analysis.classes = (content.match(/class\s+\w+/g) || []).length;
    analysis.imports = (content.match(/(?:require|import)\s/g) || []).length;
  } else if (language === 'python') {
    analysis.functions = (content.match(/def\s+\w+/g) || []).length;
    analysis.classes = (content.match(/class\s+\w+/g) || []).length;
    analysis.imports = (content.match(/(?:import|from)\s/g) || []).length;
  }

  if (analysis.functions > 20) analysis.complexity = 'high';
  else if (analysis.functions > 8) analysis.complexity = 'medium';
  else analysis.complexity = 'low';

  return analysis;
}

export function estimateMigration(
  analysis: SourceAnalysis,
  from: string,
  to: string
): MigrationEstimate {
  const idioms = IDIOM_MAP[`${from}->${to}`] || [];
  return {
    idiomRulesAvailable: idioms.length,
    estimatedEffort:
      analysis.complexity === 'high'
        ? 'significant'
        : analysis.complexity === 'medium'
          ? 'moderate'
          : 'straightforward',
    manualReviewRequired: [
      'Error handling patterns',
      'Type system differences',
      'Dependency replacements',
      'Concurrency model adaptation',
    ],
    automatable:
      idioms.length > 0
        ? `${idioms.length} syntax patterns can be auto-transformed`
        : 'Manual translation required',
  };
}
