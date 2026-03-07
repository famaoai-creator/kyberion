import { logger, safeExec, safeReadFile, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Code-Actuator v1.0.0
 * The definitive engine for code analysis, modification, and verification.
 */

interface CodeAction {
  action: 'analyze' | 'refactor' | 'verify' | 'test';
  path: string;
  command?: string;
  changes?: Array<{ old: string; new: string }>;
  options?: any;
}

async function handleAction(input: CodeAction) {
  const resolved = path.resolve(process.cwd(), input.path);

  switch (input.action) {
    case 'analyze':
      logger.info(`🔍 Analyzing code at: ${input.path}`);
      // Future: Integrate with specialized parsers (AST)
      const content = safeReadFile(resolved, { encoding: 'utf8' }) as string;
      return {
        lines: content.split('\n').length,
        size: content.length,
        exports: (content.match(/export (const|function|class|interface) (\w+)/g) || [])
      };

    case 'refactor':
      logger.info(`🔧 Refactoring code at: ${input.path}`);
      let newContent = safeReadFile(resolved, { encoding: 'utf8' }) as string;
      for (const change of input.changes || []) {
        newContent = newContent.replace(change.old, change.new);
      }
      safeWriteFile(resolved, newContent);
      return { status: 'success', applied_changes: input.changes?.length || 0 };

    case 'verify':
    case 'test':
      const cmd = input.command || (input.action === 'verify' ? 'npm run build' : 'npm test');
      logger.info(`🧪 Executing verification: ${cmd}`);
      try {
        const output = safeExec(cmd.split(' ')[0], cmd.split(' ').slice(1));
        return { status: 'success', output };
      } catch (err: any) {
        return { status: 'failed', error: err.message, stderr: err.stderr };
      }

    default:
      throw new Error(`Unsupported action: ${(input as any).action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Path to ADF JSON input',
      required: true
    })
    .parseSync();

  const inputData = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argv.input as string), 'utf8')) as CodeAction;
  const result = await handleAction(inputData);
  
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
