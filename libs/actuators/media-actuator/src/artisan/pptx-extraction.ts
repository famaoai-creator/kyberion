import { pptxUtils, runGovernedCommand } from '@agent/core';
import type { ExtractionMode, ExtractionOptions, ExtractionResult } from './extraction-engine.js';
import { collectXmlCaptures } from './xml-utils.js';

export async function processPptx(
  filePath: string,
  mode: ExtractionMode,
  result: ExtractionResult,
  options: ExtractionOptions = {}
) {
  try {
    if (mode === 'content' || mode === 'all') {
      result.layers.content = extractContent(filePath);
    }

    if (mode === 'metadata' || mode === 'all') {
      result.layers.metadata = extractMetadata(filePath);
    }

    if (mode === 'aesthetic' || mode === 'all') {
      result.layers.aesthetic = extractAesthetic(filePath);
    }

    if (mode === 'raw' || options.preserveRaw) {
      result.layers.raw = await pptxUtils.distillPptxDesign(filePath);
    }
  } catch (error: any) {
    result.layers.content = `PowerPoint content extraction failed: ${error.message}`;
    result.layers.metadata = { type: 'PowerPoint' };
    result.layers.aesthetic = { layout: 'unknown' };
  }
}

function extractContent(filePath: string): string {
  const content = listZipEntries(filePath)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .map((entry) => readZipEntryText(filePath, entry))
    .flatMap(extractSlideText)
    .join('\n\n')
    .trim();

  return content || 'No text content found in PowerPoint.';
}

function extractMetadata(filePath: string) {
  const presXml = readZipEntryText(filePath, 'ppt/presentation.xml');
  if (!presXml) {
    return { type: 'PowerPoint', slides: 0 };
  }

  const slideCount = (presXml.match(/<p:sldId /g) ?? []).length;

  return { type: 'PowerPoint', slides: slideCount };
}

function extractAesthetic(filePath: string) {
  return {
    layout: 'grid' as const,
    table_styles: Array.from(collectTableStyles(filePath)),
    branding: { logo_presence: false, tone: 'professional' as const },
  };
}

function collectTableStyles(filePath: string): Set<string> {
  const tableStyles = new Set<string>();

  const tsXml = readZipEntryText(filePath, 'ppt/tableStyles.xml');
  if (tsXml) {
    for (const styleName of collectXmlCaptures(tsXml, /styleName="([^"]+)"/g)) {
      tableStyles.add(styleName);
    }
  }

  for (const slideXml of listZipEntries(filePath)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .map((entry) => readZipEntryText(filePath, entry))) {
    for (const styleId of collectXmlCaptures(slideXml, /<a:tblStyleId>([^<]+)<\/a:tblStyleId>/g)) {
      tableStyles.add(styleId);
    }
  }

  return tableStyles;
}

function extractSlideText(xml: string): string[] {
  const textMatches = collectXmlCaptures(xml, /<a:t>([^<]*)<\/a:t>/g);
  if (textMatches.length === 0) return [];
  return [textMatches.join(' ')];
}

function listZipEntries(filePath: string): string[] {
  try {
    const result = runGovernedCommand('unzip', ['-Z1', filePath], { maxOutputMB: 20 });
    if (result.status !== 0) throw result.error || new Error(result.stderr);
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readZipEntryText(filePath: string, entryName: string): string {
  try {
    const result = runGovernedCommand('unzip', ['-p', filePath, entryName], { maxOutputMB: 20 });
    if (result.status !== 0) throw result.error || new Error(result.stderr);
    return result.stdout;
  } catch {
    return '';
  }
}
