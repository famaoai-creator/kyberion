import * as path from 'node:path';
import { DocumentArtifact } from '@agent/core/shared-business-types';
import { 
  safeWriteFile, 
  safeUnlinkSync, 
  safeMkdir, 
  safeExistsSync, 
  safeExec,
  pathResolver,
} from '@agent/core';

export interface PPTConvertOptions {
  markdown: DocumentArtifact;
  outputPath: string;
  theme?: DocumentArtifact; // Shared CSS artifact
}

export interface PPTResult {
  status: 'success';
  output: string;
  theme: string;
  cached: boolean;
}

/**
 * Universal PowerPoint Generator using Marp CLI.
 */
export async function convertToPPTX(options: PPTConvertOptions): Promise<PPTResult> {
  const { markdown, outputPath, theme } = options;

  const tempDir = pathResolver.sharedTmp('ppt');
  if (!safeExistsSync(tempDir)) {
    safeMkdir(tempDir, { recursive: true });
  }

  const markdownBody = markdown.body || '';
  const inputPath = path.join(tempDir, `${markdown.title.replace(/\s+/g, '_')}.md`);
  safeWriteFile(inputPath, markdownBody);

  let themePath: string | undefined;
  if (theme && theme.body) {
    themePath = path.join(tempDir, `${theme.title.replace(/\s+/g, '_') || 'custom'}.css`);
    safeWriteFile(themePath, theme.body);
  }

  const localMarp = pathResolver.rootResolve('node_modules/.bin/marp');
  const marpCmd = safeExistsSync(localMarp) ? localMarp : 'npx';
  const args = safeExistsSync(localMarp) ? [] : ['-y', '@marp-team/marp-cli'];
  
  args.push(inputPath, '--pptx', '--pptx-editable', '-o', outputPath, '--allow-local-files');

  if (themePath) {
    args.push('--theme', path.resolve(themePath));
  }

  try {
    await safeExec(marpCmd, args);
    return {
      status: 'success',
      output: outputPath,
      theme: theme ? theme.title : 'default',
      cached: false,
    };
  } catch (err: any) {
    // ... (rest of error handling)
  } finally {
    try {
      if (safeExistsSync(inputPath)) safeUnlinkSync(inputPath);
      if (themePath && safeExistsSync(themePath)) safeUnlinkSync(themePath);
    } catch (_e) {}
  }
}
