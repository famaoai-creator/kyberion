/**
 * Cowork Knowledge Bridge CLI (Phase 3)
 *
 * Usage:
 *   pnpm knowledge:cowork-sync
 *   pnpm knowledge:cowork-sync -- --direction kyberion-to-cowork
 *   pnpm knowledge:cowork-sync -- --direction cowork-to-kyberion --paths path1.md path2.md
 *   pnpm knowledge:cowork-sync -- --max-hints 20
 */

import { runCoworkKnowledgeSync } from '@agent/core/cowork-knowledge-bridge';
import { defineScript, isDirectScript } from './lib/harness.js';

function usage(): string {
  return 'Usage: pnpm knowledge:cowork-sync -- [--direction cowork-to-kyberion|kyberion-to-cowork|both] [--paths <paths...>] [--max-hints <n>]';
}

function parseArgs(argv: string[]): {
  direction: 'cowork-to-kyberion' | 'kyberion-to-cowork' | 'both';
  paths: string[];
  maxHints: number;
  help: boolean;
} {
  const args = argv;
  const help = args.includes('--help') || args.includes('-h') || args.includes('help');
  let direction: 'cowork-to-kyberion' | 'kyberion-to-cowork' | 'both' = 'both';
  const paths: string[] = [];
  let maxHints = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--direction' && args[i + 1]) {
      const d = args[++i];
      if (d === 'cowork-to-kyberion' || d === 'kyberion-to-cowork' || d === 'both') {
        direction = d;
      }
    } else if (args[i] === '--paths') {
      while (args[i + 1] && !args[i + 1].startsWith('--')) {
        paths.push(args[++i]);
      }
    } else if (args[i] === '--max-hints' && args[i + 1]) {
      maxHints = parseInt(args[++i], 10) || 50;
    }
  }

  return { direction, paths, maxHints, help };
}

export const runCoworkKnowledgeBridge = defineScript({
  name: 'knowledge:cowork-sync',
  flags: [],
  run(context) {
    const { direction, paths, maxHints, help } = parseArgs(context.argv);
    if (help) {
      const result = { status: 'help', usage: usage() };
      context.print(result);
      return result;
    }

    const result = runCoworkKnowledgeSync({
      direction,
      coworkArtifactPaths: paths,
      maxHints,
    });

    context.print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'cowork_knowledge_bridge.ts') ||
  isDirectScript(import.meta.url, 'cowork_knowledge_bridge.js')
)
  void runCoworkKnowledgeBridge();
