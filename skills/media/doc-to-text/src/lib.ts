import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { DocumentArtifact } from '@agent/core/shared-business-types';

/**
 * Enhanced doc-to-text: Extracts slide-by-slide content and assets.
 */
export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pptx') {
    return extractPagedFromPPTX(filePath);
  }

  const textract = require('textract');
  return new Promise((resolve, reject) => {
    textract.fromFileWithPath(filePath, (error: Error, text: string) => {
      if (error) reject(error);
      else resolve(text);
    });
  });
}

/**
 * PPTX specific logic to preserve slide boundaries and asset IDs.
 */
async function extractPagedFromPPTX(pptxPath: string): Promise<string> {
  const tmpDir = path.resolve('scratch/tmp-paged-pptx');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  execSync('unzip -q "' + pptxPath + '" -d "' + tmpDir + '"');

  const slidesDir = path.join(tmpDir, 'ppt/slides');
  const slideFiles = fs
    .readdirSync(slidesDir)
    .filter((f) => f.startsWith('slide') && f.endsWith('.xml'));
  slideFiles.sort((a, b) => parseInt(a.replace('slide', '')) - parseInt(b.replace('slide', '')));

  let pagedMarkdown = '';
  for (const file of slideFiles) {
    const content = fs.readFileSync(path.join(slidesDir, file), 'utf8');
    const textMatches = content.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
    const slideText = textMatches
      .map((m) => m.replace(/<a:t>/, '').replace(/<\/a:t>/, ''))
      .join(' ');

    if (pagedMarkdown) pagedMarkdown += '\n---\n'; // Physical Marp Slide Break
    pagedMarkdown += slideText.trim();
  }

  // Also Copy media to a predictable location for the pipeline
  const mediaDir = path.join(tmpDir, 'ppt/media');
  const projectAssetDir = path.resolve('active/projects/pptx-replication/assets');
  if (fs.existsSync(mediaDir)) {
    if (!fs.existsSync(projectAssetDir)) fs.mkdirSync(projectAssetDir, { recursive: true });
    execSync('cp "' + mediaDir + '"/* "' + projectAssetDir + '/"');
  }

  fs.rmSync(tmpDir, { recursive: true });
  return pagedMarkdown;
}

export function extractDesignMetadata(pptxPath: string): any {
  const tmpDir = path.resolve('scratch/tmp-design-metadata');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    execSync('unzip -q "' + pptxPath + '" -d "' + tmpDir + '"');
    const themeFile = path.join(tmpDir, 'ppt/theme/theme1.xml');
    const metadata: any = { colors: {} };

    if (fs.existsSync(themeFile)) {
      const content = fs.readFileSync(themeFile, 'utf8');
      const dk1 = content.match(/<a:dk1>.*?lastClr="([^"]+)"/);
      const lt1 = content.match(/<a:lt1>.*?lastClr="([^"]+)"/);
      const accent1 = content.match(/<a:accent1>.*?val="([^"]+)"/);

      metadata.colors = {
        dark1: dk1 ? '#' + dk1[1] : '#000000',
        light1: lt1 ? '#' + lt1[1] : '#FFFFFF',
        accent1: accent1 ? '#' + accent1[1] : '#4472C4',
      };
    }
    return metadata;
  } catch (e) {
    return { colors: { accent1: '#4472C4' } };
  } finally {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  }
}

export function createDocumentArtifact(
  title: string,
  body: string,
  metadata: any = {}
): DocumentArtifact {
  return {
    title,
    body,
    format: 'markdown',
    metadata,
  };
}
