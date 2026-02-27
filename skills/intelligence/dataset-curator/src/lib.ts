import * as path from 'node:path';

export interface CurateResult {
  records: any[];
  originalCount: number;
  cleanedCount: number;
  removed: number;
  columns: string[];
  qualityReport: {
    nulls: number;
    duplicates: number;
    issues: string[];
  };
}

export function detectFormat(filePath: string, content: string): 'json' | 'csv' | 'text' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.txt' || ext === '.text') return 'text';

  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  const lines = trimmed.split(new RegExp('\\r?\\n'));
  if (lines.length > 1 && lines[0].includes(',')) return 'csv';

  return 'text';
}

export function curateJson(content: string): CurateResult {
  const data = JSON.parse(content);
  const records = Array.isArray(data) ? data : [data];
  const originalCount = records.length;
  const issues: string[] = [];
  const seen = new Set<string>();
  const cleaned: any[] = [];
  let nullCount = 0;

  for (const record of records) {
    if (record === null || record === undefined) {
      nullCount++;
      continue;
    }
    if (typeof record === 'object' && !Array.isArray(record)) {
      for (const val of Object.values(record)) {
        if (val === null || val === undefined || val === '') nullCount++;
      }
    }
    const serialized = JSON.stringify(record);
    if (seen.has(serialized)) continue;
    seen.add(serialized);
    cleaned.push(record);
  }

  if (originalCount - cleaned.length > 0) {
    issues.push(`Found ${originalCount - cleaned.length} duplicate or null record(s)`);
  }

  return {
    records: cleaned,
    originalCount,
    cleanedCount: cleaned.length,
    removed: originalCount - cleaned.length,
    columns: cleaned.length > 0 && typeof cleaned[0] === 'object' ? Object.keys(cleaned[0]) : [],
    qualityReport: {
      nulls: nullCount,
      duplicates: originalCount - cleaned.length - nullCount,
      issues,
    },
  };
}

export function curateText(content: string): CurateResult {
  const lines = content.split(new RegExp('\\r?\\n'));
  const originalCount = lines.length;
  const cleaned = Array.from(new Set(lines.map((l) => l.trim()).filter((l) => l.length > 0)));

  return {
    records: cleaned,
    originalCount,
    cleanedCount: cleaned.length,
    removed: originalCount - cleaned.length,
    columns: [],
    qualityReport: { nulls: 0, duplicates: originalCount - cleaned.length, issues: [] },
  };
}
