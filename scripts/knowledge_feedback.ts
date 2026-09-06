#!/usr/bin/env node
import { recordHumanKnowledgeFeedback } from '@agent/core/knowledge-feedback-loop';
import { currentScope } from '@agent/core/scope-context';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export const runKnowledgeFeedback = defineScript({
  name: 'knowledge-feedback',
  flags: [],
  run(context) {
    const documentPath = flag(context.argv, '--path');
    const verdict = flag(context.argv, '--verdict') as
      'useful' | 'stale' | 'wrong' | 'not_useful' | undefined;
    if (
      !documentPath ||
      !verdict ||
      !['useful', 'stale', 'wrong', 'not_useful'].includes(verdict)
    ) {
      throw new Error(
        'Usage: pnpm knowledge-feedback --path <knowledge-relative-path> --verdict <useful|stale|wrong|not_useful> [--reason <text>]'
      );
    }
    const target = recordHumanKnowledgeFeedback({
      document_path: documentPath,
      verdict,
      reason: flag(context.argv, '--reason'),
      actor: getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
      source: 'cli',
      scope: currentScope(),
    });
    context.print({ status: 'recorded', feedback_path: target });
  },
});

if (
  isDirectScript(import.meta.url, 'knowledge_feedback.ts') ||
  isDirectScript(import.meta.url, 'knowledge_feedback.js')
)
  void runKnowledgeFeedback();
