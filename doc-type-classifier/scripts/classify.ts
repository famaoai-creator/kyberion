/**
 * TypeScript pilot: doc-type-classifier
 * Classifies document type using the shared classification engine.
 *
 * Build: npm run build
 * Run:   node dist/doc-type-classifier/scripts/classify.js --input <file>
 */

import * as fs from 'fs';
import * as path from 'path';
import { runSkill } from '../../scripts/lib/skill-wrapper.js';

interface ClassifyResult {
  type: string;
  confidence: number;
  matches: number;
}

const RULES: Record<string, string[]> = {
  'meeting-notes': ['議事録', '参加者', '決定事項', 'Next Action', 'Agenda'],
  specification: ['仕様書', '設計', 'Architecture', 'Sequence', 'API Definition'],
  report: ['報告書', '月次', '週報', 'Report', 'Summary'],
  contract: ['契約書', '甲', '乙', '条', 'Agreement'],
};

function classify(content: string): ClassifyResult {
  let bestType = 'unknown';
  let maxScore = 0;
  const totalKeywords = Math.max(...Object.values(RULES).map((kw) => kw.length), 1);

  for (const [type, keywords] of Object.entries(RULES)) {
    let score = 0;
    for (const word of keywords) {
      if (content.includes(word)) score++;
    }
    if (score > maxScore) {
      maxScore = score;
      bestType = type;
    }
  }

  const confidence = maxScore > 0 ? Math.min(0.7 + (maxScore / totalKeywords) * 0.3, 1.0) : 0;

  return {
    type: bestType,
    confidence: Math.round(confidence * 100) / 100,
    matches: maxScore,
  };
}

// CLI entry point
const inputArg = process.argv.indexOf('--input');
const inputFile = inputArg !== -1 ? process.argv[inputArg + 1] : undefined;

if (!inputFile) {
  console.error('Usage: classify.ts --input <file>');
  process.exit(1);
}

runSkill<ClassifyResult>('doc-type-classifier', () => {
  const content = fs.readFileSync(path.resolve(inputFile!), 'utf8');
  return classify(content);
});
