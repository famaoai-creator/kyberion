import { logger, safeExec, safeReadFile, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as util from 'node:util';

/**
 * Code-Actuator v1.2.0 [LIVE-REPL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 */

interface CodeAction {
  action: 'analyze' | 'refactor' | 'verify' | 'test' | 'run_live_js';
  path?: string;
  code?: string; // For run_live_js
  command?: string;
  changes?: Array<{ old: string; new: string }>;
}

async function handleAction(input: CodeAction) {
  switch (input.action) {
    case 'run_live_js':
      if (!input.code) throw new Error('code is required for run_live_js action.');
      
      const logs: string[] = [];
      const sandbox = {
        Buffer,
        process: { env: { ...process.env } }, // Limited env access
        console: {
          log: (...args: any[]) => {
            const msg = args.map(a => typeof a === 'object' ? util.inspect(a) : String(a)).join(' ');
            logs.push(msg);
            logger.info(`[JS-LOG] ${msg}`);
          },
          error: (...args: any[]) => {
            const msg = args.map(a => typeof a === 'object' ? util.inspect(a) : String(a)).join(' ');
            logs.push(`ERROR: ${msg}`);
            logger.error(`[JS-ERROR] ${msg}`);
          }
        },
        setTimeout,
        clearTimeout,
        // Add more globals as needed, e.g. fetch
      };

      const context = vm.createContext(sandbox);
      const wrappedCode = `(async () => {\n${input.code}\n})()`;

      try {
        const script = new vm.Script(wrappedCode, { filename: 'live_repl.js' });
        const result = await script.runInContext(context);
        return { 
          status: 'success', 
          output: result, 
          logs 
        };
      } catch (err: any) {
        return { 
          status: 'failed', 
          error: err.message, 
          stack: err.stack,
          logs 
        };
      }

    case 'analyze':
      if (!input.path) throw new Error('path is required');
      const resolvedAnalyze = path.resolve(process.cwd(), input.path);
      const content = safeReadFile(resolvedAnalyze, { encoding: 'utf8' }) as string;
      return { lines: content.split('\n').length, size: content.length };

    case 'refactor':
      if (!input.path) throw new Error('path is required');
      const resolvedRefactor = path.resolve(process.cwd(), input.path);
      let newContent = safeReadFile(resolvedRefactor, { encoding: 'utf8' }) as string;
      for (const change of input.changes || []) {
        newContent = newContent.replace(change.old, change.new);
      }
      safeWriteFile(resolvedRefactor, newContent);
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
