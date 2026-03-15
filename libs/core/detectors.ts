import { safeReadFile } from './secure-io.js';
import * as jschardet from 'jschardet';
import LanguageDetect from 'languagedetect';

const lngDetector = new LanguageDetect();

/**
 * Detects file encoding and line endings.
 */
export function detectEncoding(bufferOrPath: string | Buffer) {
  const buffer = Buffer.isBuffer(bufferOrPath)
    ? bufferOrPath
    : safeReadFile(bufferOrPath, { encoding: null }) as Buffer;
  const result = jschardet.detect(buffer);
  const content = buffer.toString();

  let lineEnding = 'unknown';
  if (content.includes('\r\n')) lineEnding = 'CRLF';
  else if (content.includes('\n')) lineEnding = 'LF';
  else if (content.includes('\r')) lineEnding = 'CR';

  return { ...result, lineEnding };
}

/**
 * Detects natural language of text.
 */
export function detectLanguage(text: string) {
  const results = lngDetector.detect(text, 1);
  if (results.length > 0) {
    return { language: results[0][0], confidence: results[0][1] };
  }
  return { language: 'unknown', confidence: 0 };
}

/**
 * Detects data format (json, yaml, csv).
 */
export function detectFormat(text: string) {
  let format = 'unknown';
  let confidence = 0.0;
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return { format: 'json', confidence: 1.0 };
    } catch (_) {}
  }

  if (trimmed.includes('---') || trimmed.includes(': ')) {
    format = 'yaml';
    confidence = 0.7;
  } else if (trimmed.includes(',')) {
    const lines = trimmed.split('\n');
    if (lines.length > 0 && lines[0].split(',').length > 1) {
      format = 'csv';
      confidence = 0.6;
    }
  }

  return { format, confidence };
}
