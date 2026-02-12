#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true, description: 'Source file to analyze for porting' })
  .option('from', { type: 'string', description: 'Source language (auto-detected if omitted)' })
  .option('to', { alias: 't', type: 'string', demandOption: true, choices: ['javascript', 'typescript', 'python', 'go', 'rust'], description: 'Target language' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const LANG_DETECTION = { '.js': 'javascript', '.cjs': 'javascript', '.mjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.php': 'php' };
const IDIOM_MAP = {
  'javascript->python': [
    { from: /const\s+(\w+)\s*=\s*/g, to: '$1 = ' },
    { from: /let\s+(\w+)\s*=\s*/g, to: '$1 = ' },
    { from: /function\s+(\w+)\s*\((.*?)\)\s*\{/g, to: 'def $1($2):' },
    { from: /console\.log/g, to: 'print' },
    { from: /===|!==/g, to: m => m === '===' ? '==' : '!=' },
    { from: /\bfor\s*\(\s*(?:let|const|var)\s+(\w+)\s*=\s*0;\s*\1\s*<\s*(\w+)(?:\.length)?;\s*\1\+\+\s*\)/g, to: 'for $1 in range($2)' },
  ],
  'javascript->go': [
    { from: /const\s+(\w+)\s*=\s*/g, to: '$1 := ' },
    { from: /function\s+(\w+)\s*\((.*?)\)\s*\{/g, to: 'func $1($2) {' },
    { from: /console\.log/g, to: 'fmt.Println' },
  ],
};

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return LANG_DETECTION[ext] || 'unknown';
}

function analyzeSource(content, language) {
  const analysis = { lines: content.split('\n').length, functions: 0, classes: 0, imports: 0, complexity: 'low' };
  if (language === 'javascript' || language === 'typescript') {
    analysis.functions = (content.match(/(?:function\s+\w+|const\s+\w+\s*=\s*(?:\(|async))/g) || []).length;
    analysis.classes = (content.match(/class\s+\w+/g) || []).length;
    analysis.imports = (content.match(/(?:require|import)\s/g) || []).length;
  } else if (language === 'python') {
    analysis.functions = (content.match(/def\s+\w+/g) || []).length;
    analysis.classes = (content.match(/class\s+\w+/g) || []).length;
    analysis.imports = (content.match(/(?:import|from)\s/g) || []).length;
  }
  analysis.complexity = analysis.functions > 20 ? 'high' : analysis.functions > 8 ? 'medium' : 'low';
  return analysis;
}

function estimateMigration(analysis, from, to) {
  const idioms = IDIOM_MAP[`${from}->${to}`] || [];
  return {
    idiomRulesAvailable: idioms.length,
    estimatedEffort: analysis.complexity === 'high' ? 'significant' : analysis.complexity === 'medium' ? 'moderate' : 'straightforward',
    manualReviewRequired: ['Error handling patterns', 'Type system differences', 'Dependency replacements', 'Concurrency model adaptation'],
    automatable: idioms.length > 0 ? `${idioms.length} syntax patterns can be auto-transformed` : 'Manual translation required',
  };
}

runSkill('technology-porter', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const content = fs.readFileSync(resolved, 'utf8');
  const fromLang = argv.from || detectLanguage(resolved);
  const analysis = analyzeSource(content, fromLang);
  const migration = estimateMigration(analysis, fromLang, argv.to);
  const result = {
    source: path.basename(resolved), fromLanguage: fromLang, toLanguage: argv.to,
    sourceAnalysis: analysis, migrationPlan: migration,
    recommendations: [
      `Source: ${fromLang} (${analysis.lines} lines, ${analysis.functions} functions)`,
      `Target: ${argv.to} - ${migration.estimatedEffort} effort`,
      ...migration.manualReviewRequired.slice(0, 2).map(r => `[manual] ${r}`),
    ],
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
