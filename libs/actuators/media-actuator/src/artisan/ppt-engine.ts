import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { DocumentArtifact } from '@agent/core/shared-business-types';
import { safeWriteFile, safeUnlinkSync, safeMkdir } from '@agent/core/secure-io';

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

  const tempDir = path.join(process.cwd(), 'temp_ppt');
  if (!fs.existsSync(tempDir)) {
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

  const localMarp = path.resolve(process.cwd(), 'node_modules/.bin/marp');
  const marpCmd = fs.existsSync(localMarp) ? `"${localMarp}"` : 'npx -y @marp-team/marp-cli';

  let cmd = `${marpCmd} "${inputPath}" --pptx --pptx-editable -o "${outputPath}" --allow-local-files`;

  if (themePath) {
    cmd += ` --theme "${path.resolve(themePath)}"`;
  }

  try {
    execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] });
    return {
      status: 'success',
      output: outputPath,
      theme: theme ? theme.title : 'default',
      cached: false,
    };
  } catch (err: any) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    let diagnostic = 'Marp CLI failed to generate PPTX.';

    if (stderr.includes('not found'))
      diagnostic = 'Marp CLI not found. Please ensure dependencies are installed.';
    if (stderr.includes('theme')) diagnostic = `Theme invalid or missing: ${theme?.title}`;
    if (stderr.includes('Permission denied'))
      diagnostic = `Permission denied writing to: ${outputPath}`;

    throw new Error(`${diagnostic}\nDetails: ${stderr || err.message}`);
  } finally {
    try {
      if (fs.existsSync(inputPath)) safeUnlinkSync(inputPath);
      if (themePath && fs.existsSync(themePath)) safeUnlinkSync(themePath);
    } catch (_e) {}
  }
}
