import { logger, safeExec, safeReadFile, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';

/**
 * Code-Actuator v1.1.0 [SECURE-IO ENFORCED]
 * Strictly compliant with Layer 2 (Shield).
 */

interface CodeAction {
  action: 'analyze' | 'refactor' | 'verify' | 'test';
  path: string;
  command?: string;
  changes?: Array<{ old: string; new: string }>;
}

async function handleAction(input: CodeAction) {
  const resolved = path.resolve(process.cwd(), input.path);

  switch (input.action) {
    case 'analyze':
      const content = safeReadFile(resolved, { encoding: 'utf8' }) as string;
      return { lines: content.split('\n').length, size: content.length };

    case 'refactor':
      let newContent = safeReadFile(resolved, { encoding: 'utf8' }) as string;
      for (const change of input.changes || []) {
        newContent = newContent.replace(change.old, change.new);
      }
      safeWriteFile(resolved, newContent);
      return { status: 'success' };

    case 'verify':
    case 'test':
      const cmd = input.command || (input.action === 'verify' ? 'npm run build' : 'npm test');
      try {
        const output = safeExec(cmd.split(' ')[0], cmd.split(' ').slice(1));
        return { status: 'success', output };
      } catch (err: any) {
        return { status: 'failed', error: err.message };
      }

    default:
      throw new Error(`Unsupported action: ${input.action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
