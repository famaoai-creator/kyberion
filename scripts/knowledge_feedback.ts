#!/usr/bin/env node
import { currentScope, recordHumanKnowledgeFeedback } from '@agent/core';
import { getRegisteredEnvText } from '@agent/core/foundation';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const documentPath = flag(args, '--path');
const verdict = flag(args, '--verdict') as 'useful' | 'stale' | 'wrong' | 'not_useful' | undefined;
if (!documentPath || !verdict || !['useful', 'stale', 'wrong', 'not_useful'].includes(verdict)) {
  console.error(
    'Usage: pnpm knowledge-feedback --path <knowledge-relative-path> --verdict <useful|stale|wrong|not_useful> [--reason <text>]'
  );
  process.exit(1);
}
const target = recordHumanKnowledgeFeedback({
  document_path: documentPath,
  verdict,
  reason: flag(args, '--reason'),
  actor: getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
  source: 'cli',
  scope: currentScope(),
});
console.log(JSON.stringify({ status: 'recorded', feedback_path: target }, null, 2));
