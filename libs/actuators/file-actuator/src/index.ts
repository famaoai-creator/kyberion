import { logger, runSkillAsync, safeReadFile, safeWriteFile, safeExec } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * File-Actuator v1.0.0
 * Unified interface for all filesystem operations.
 */

interface FileAction {
  action: 'read' | 'write' | 'search' | 'list' | 'delete' | 'exists';
  path: string;
  content?: string;
  pattern?: string;
  recursive?: boolean;
  options?: any;
}

async function handleAction(input: FileAction) {
  const resolved = path.resolve(process.cwd(), input.path);

  switch (input.action) {
    case 'read':
      logger.info(`📖 Reading file: ${input.path}`);
      return { content: safeReadFile(resolved, { encoding: 'utf8' }) };

    case 'write':
      logger.info(`💾 Writing file: ${input.path}`);
      safeWriteFile(resolved, input.content || '');
      return { status: 'success', path: input.path };

    case 'search':
      logger.info(`🔍 Searching pattern "${input.pattern}" in ${input.path}`);
      try {
        const results = safeExec('rg', ['--json', input.pattern || '', resolved]);
        return { results: JSON.parse(results) };
      } catch (err: any) {
        logger.warn(`ripgrep not found, falling back to native search: ${err.message}`);
        const results = [];
        const ignoreDirs = ['node_modules', 'dist', '.git', 'coverage'];
        
        function walk(dir: string) {
          try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
              if (ignoreDirs.includes(file)) continue;
              const fullPath = path.join(dir, file);
              try {
                const stats = fs.statSync(fullPath);
                if (stats.isDirectory()) {
                  walk(fullPath);
                } else if (stats.isFile()) {
                  const content = fs.readFileSync(fullPath, 'utf8');
                  const regex = new RegExp(input.pattern || '', 'g');
                  let match;
                  while ((match = regex.exec(content)) !== null) {
                    const line = content.substring(0, match.index).split('\n').length;
                    results.push({ file: path.relative(process.cwd(), fullPath), line, match: match[0] });
                  }
                }
              } catch (e) {
                // Skip inaccessible files
              }
            }
          } catch (e) {
            // Skip inaccessible directories
          }
        }
        
        walk(resolved);
        return { results };
      }

    case 'list':
      logger.info(`📂 Listing directory: ${input.path}`);
      const files = fs.readdirSync(resolved);
      return { files };

    case 'exists':
      return { exists: fs.existsSync(resolved) };

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

  const inputData = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argv.input as string), 'utf8')) as FileAction;
  const result = await handleAction(inputData);
  
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
