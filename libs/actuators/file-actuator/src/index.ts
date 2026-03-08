import { logger, safeReadFile, safeWriteFile, safeExec, safeReaddir, safeStat, safeUnlink, safeMkdir, safeExistsSync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';

/**
 * File-Actuator v1.2.0 [SECURE-IO ENFORCED]
 * Unified interface for all high-fidelity filesystem operations.
 * Strictly compliant with Layer 2 (Shield).
 */

interface FileAction {
  action: 'read' | 'write' | 'search' | 'list' | 'delete' | 'exists' | 'stat' | 'replace' | 'tail';
  path: string;
  content?: string;
  pattern?: string;
  replacement?: string;
  recursive?: boolean;
  last_pos?: number;
  options?: any;
}

async function handleAction(input: FileAction) {
  const resolved = path.resolve(process.cwd(), input.path);

  switch (input.action) {
    case 'tail': {
      logger.info(`🔍 Tailing file: ${input.path} from pos ${input.last_pos || 0}`);
      const stats = safeStat(resolved);
      const lastPos = input.last_pos || 0;
      let newContent = '';
      if (stats.size > lastPos) {
        const fullContent = safeReadFile(resolved, { encoding: 'utf8' }) as string;
        newContent = fullContent.substring(lastPos);
      } else if (stats.size < lastPos) {
        return { content: '', last_pos: 0, size: stats.size, truncated: true };
      }
      return { content: newContent, last_pos: stats.size, size: stats.size };
    }
    case 'replace': {
      logger.info(`📝 Replacing "${input.pattern}" with "${input.replacement}" in ${input.path}`);
      const oldContent = safeReadFile(resolved, { encoding: 'utf8' }) as string;
      const newContent = oldContent.replace(new RegExp(input.pattern || '', 'g'), input.replacement || '[REDACTED]');
      safeWriteFile(resolved, newContent);
      return { status: 'success', path: input.path };
    }
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
        logger.warn(`ripgrep failed/missing, using resilient native search.`);
        const results: any[] = [];
        const ignoreDirs = ['node_modules', 'dist', '.git', 'coverage'];
        
        function walk(dir: string) {
          try {
            const files = safeReaddir(dir);
            for (const file of files) {
              if (ignoreDirs.includes(file)) continue;
              const fullPath = path.join(dir, file);
              try {
                const s = safeStat(fullPath);
                if (s.isDirectory()) {
                  walk(fullPath);
                } else if (s.isFile()) {
                  const content = safeReadFile(fullPath, { encoding: 'utf8' }) as string;
                  const regex = new RegExp(input.pattern || '', 'g');
                  let match;
                  while ((match = regex.exec(content)) !== null) {
                    const line = content.substring(0, match.index).split('\n').length;
                    results.push({ file: path.relative(process.cwd(), fullPath), line, match: match[0] });
                  }
                }
              } catch (e) {}
            }
          } catch (e) {}
        }
        walk(resolved);
        return { results };
      }

    case 'list':
      logger.info(`📂 Listing directory: ${input.path}`);
      return { files: safeReaddir(resolved) };

    case 'stat':
      logger.info(`📊 Getting metadata for: ${input.path}`);
      const s = safeStat(resolved);
      return {
        size: s.size,
        mtime: s.mtime,
        birthtime: s.birthtime,
        isDirectory: s.isDirectory(),
        isFile: s.isFile()
      };

    case 'delete':
      logger.warn(`🗑️  DELETING path: ${input.path}`);
      const targetStat = safeStat(resolved);
      if (targetStat.isDirectory()) {
        // Core doesn't have recursive rm yet, fallback to safeExec
        safeExec('rm', ['-rf', resolved]);
      } else {
        safeUnlink(resolved);
      }
      return { status: 'deleted', path: input.path };

    case 'exists':
      // Physical exists check via safeStat (throws if not found)
      try {
        safeStat(resolved);
        return { exists: true };
      } catch (_) {
        return { exists: false };
      }

    default:
      throw new Error(`Unsupported action: ${(input as any).action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = path.resolve(process.cwd(), argv.input as string);
  const inputData = JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string) as FileAction;
  const result = await handleAction(inputData);
  
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
