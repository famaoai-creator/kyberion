#!/usr/bin/env node

const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath: _validateFilePath } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs().option('input', { alias: 'i', type: 'string' }).argv;

const EXT_MAP = {
  '.js': 'javascript',
  '.ts': 'typescript',
  '.py': 'python',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.rs': 'rust',
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.json': 'json',
  '.md': 'markdown',
  '.sh': 'shell',
};

const KEYWORDS = {
  python: ['def ', 'import ', 'print('],
  javascript: ['const ', 'function ', 'console.log'],
  java: ['public class ', 'System.out.println'],
  go: ['package main', 'fmt.Println'],
  rust: ['fn main', 'println!'],
};

runSkill('code-lang-detector', () => {
  const input = argv.input;
  const content = fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : input;

  // 1. Extension check
  const ext = require('path').extname(input).toLowerCase();
  if (EXT_MAP[ext]) {
    return { lang: EXT_MAP[ext], confidence: 1.0, method: 'extension' };
  }

  // 2. Keyword check
  let bestLang = 'unknown';
  let maxScore = 0;

  for (const [lang, words] of Object.entries(KEYWORDS)) {
    let score = 0;
    words.forEach((w) => {
      if (content.includes(w)) score++;
    });
    if (score > maxScore) {
      maxScore = score;
      bestLang = lang;
    }
  }

  return { lang: bestLang, confidence: maxScore > 0 ? 0.8 : 0, method: 'keyword' };
});
