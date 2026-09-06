import * as yaml from 'js-yaml';
import * as Papa from 'papaparse';
import * as path from 'node:path';
import { parseSafeJsonInput } from './foundation/safe-json.js';

/**
 * Data Utils Core Library.
 * Abstracted from the legacy data-transformer skill.
 */

export type DataFormat = 'json' | 'yaml' | 'csv';

export function detectFormat(filePath: string): DataFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.csv') return 'csv';
  throw new Error(`Unsupported file extension: ${ext}`);
}

export function parseData(content: string, format: DataFormat): any {
  try {
    if (format === 'json') return parseSafeJsonInput(content, 'data');
    if (format === 'yaml') return yaml.load(content);
    if (format === 'csv') {
      const results = Papa.parse(content, { header: true, skipEmptyLines: true });
      return results.data;
    }
  } catch (err: any) {
    throw new Error(`Failed to parse ${format}: ${err.message}`);
  }
}

export function stringifyData(data: any, format: DataFormat): string {
  try {
    if (format === 'json') return JSON.stringify(data, null, 2);
    if (format === 'yaml') return yaml.dump(data);
    if (format === 'csv') {
      return Papa.unparse(data);
    }
  } catch (err: any) {
    throw new Error(`Failed to stringify ${format}: ${err.message}`);
  }
  return '';
}
