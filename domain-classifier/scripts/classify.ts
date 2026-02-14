/**
 * TypeScript pilot: domain-classifier
 * Classifies text content into business domains.
 *
 * Build: npm run build
 * Run:   node dist/domain-classifier/scripts/classify.js --input <file>
 */

import * as fs from 'fs';
import * as path from 'path';
import { runSkill } from '../../scripts/lib/skill-wrapper.js';

interface ClassifyResult {
  domain: string;
  confidence: number;
  matches: number;
}

const DOMAINS: Record<string, string[]> = {
  tech: ['API', 'REST', 'GraphQL', 'Docker', 'Kubernetes', 'CI/CD', 'Git'],
  finance: ['ROI', '売上', 'P&L', 'Budget', 'Revenue', 'EBITDA', 'Forecast'],
  legal: ['契約', '条項', '免責', 'Liability', 'Compliance', 'Regulation'],
  hr: ['採用', '人事', 'Onboarding', 'Performance', 'Compensation', 'Benefits'],
};

function classify(content: string): ClassifyResult {
  let bestDomain = 'unknown';
  let maxScore = 0;
  const totalKeywords = Math.max(...Object.values(DOMAINS).map((kw) => kw.length), 1);

  for (const [domain, keywords] of Object.entries(DOMAINS)) {
    let score = 0;
    for (const word of keywords) {
      if (content.includes(word)) score++;
    }
    if (score > maxScore) {
      maxScore = score;
      bestDomain = domain;
    }
  }

  const confidence = maxScore > 0 ? Math.min(0.7 + (maxScore / totalKeywords) * 0.3, 1.0) : 0;

  return {
    domain: bestDomain,
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

runSkill<ClassifyResult>('domain-classifier', () => {
  const content = fs.readFileSync(path.resolve(inputFile!), 'utf8');
  return classify(content);
});
