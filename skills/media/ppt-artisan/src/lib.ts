import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { DocumentArtifact } from '@agent/core/shared-business-types';
import { readArtifact } from '@agent/core/secure-io';

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

export async function convertToPPTX(options: PPTConvertOptions): Promise<PPTResult> {
  const { markdown, outputPath, theme } = options;

  // Resolve content: either from 'body' or from secure hashed 'pointer'
  const markdownBody = markdown.pointer
    ? (readArtifact as any)(markdown.pointer).toString()
    : markdown.body;

  const themeBody = theme
    ? theme.pointer
      ? (readArtifact as any)(theme.pointer).toString()
      : theme.body
    : undefined;

  // For Marp CLI, we must write artifacts to temp files if they aren't already on disk
  const tempDir = path.join(process.cwd(), 'temp_ppt');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const inputPath = path.join(tempDir, `${markdown.title.replace(/\s+/g, '_')}.md`);
  safeWriteFile(inputPath, markdownBody);

  let themePath: string | undefined;
  if (themeBody) {
    themePath = path.join(tempDir, `${theme?.title.replace(/\s+/g, '_') || 'custom'}.css`);
    safeWriteFile(themePath, themeBody);
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
    // Cleanup temp files
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (themePath && fs.existsSync(themePath)) fs.unlinkSync(themePath);
    } catch (_e) {
      /* ignore */
    }
  }
}
