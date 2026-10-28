/** Inspect outcomes; never executes the selected asset or accepts a client scope override. */
import { currentScope } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFileSnapshot } from '@agent/core/secure-io';
import { inspectKnowledgeReuse } from '@agent/core/knowledge/knowledge-verification';
import { inspectPipelineReuse } from '@agent/core/pipeline/pipeline-reuse';
import { validatePipelineAdf } from '@agent/core/pipeline/pipeline-contract';
import { createHash } from 'node:crypto';
import { defineScript, isDirectScript } from './lib/harness.js';
import { parseGuardedCliArgs } from './lib/cli-guard.js';

export const runLearningReuse = defineScript({
  name: 'learning-reuse',
  flags: ['json'],
  run: ({ argv, print }) => {
    const parsed = parseGuardedCliArgs(
      argv,
      {
        command: 'pnpm kyberion learning reuse',
        manifestId: 'script.learning.reuse',
        options: [
          { flag: '--input', value: '<published-asset>' },
          { flag: '--kind', value: '<knowledge|pipeline|procedure>' },
          { flag: '--json' },
        ],
      },
      print
    );
    if (parsed.handled) return;
    const ref = parsed.options['--input'];
    if (typeof ref !== 'string' || parsed.positionals.length)
      throw new Error('Select --input <published-asset>');
    const file = pathResolver.rootResolve(ref);
    const snapshot = safeReadFileSnapshot(file, 2 * 1024 * 1024);
    const requestedKind = parsed.options['--kind'];
    if (
      requestedKind !== undefined &&
      !['knowledge', 'pipeline', 'procedure'].includes(String(requestedKind))
    )
      throw new Error('Select --kind knowledge|pipeline|procedure');
    let json: unknown;
    try {
      json = JSON.parse(snapshot.toString('utf8'));
    } catch {
      /* Text knowledge is not an ADF. */
    }
    const looksLikePipeline =
      !!json &&
      typeof json === 'object' &&
      !Array.isArray(json) &&
      (json as Record<string, unknown>).action === 'pipeline';
    const kind = requestedKind ?? (looksLikePipeline ? 'pipeline' : 'knowledge');
    if (kind === 'pipeline') validatePipelineAdf(json);
    const sourceSha256 = createHash('sha256').update(snapshot).digest('hex');
    const documentPath = pathResolver.toRepoRelative(file);
    const scope = currentScope();
    const input = { documentPath, sourceSha256, scope };
    print({
      ok: true,
      document_path: documentPath,
      scope,
      kind,
      reuse: kind === 'pipeline' ? inspectPipelineReuse(input) : inspectKnowledgeReuse(input),
    });
  },
});
if (
  isDirectScript(import.meta.url, 'learning_reuse.ts') ||
  isDirectScript(import.meta.url, 'learning_reuse.js')
)
  void runLearningReuse();
