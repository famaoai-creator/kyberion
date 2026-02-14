#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { validateFilePath } = require('@agent/core/validators');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    describe: 'Path to data file (JSON/CSV/text)',
    demandOption: true,
  })
  .option('out', { alias: 'o', type: 'string', describe: 'Output file path' })
  .option('format', {
    alias: 'f',
    type: 'string',
    describe: 'Data format',
    choices: ['json', 'csv', 'text'],
  }).argv;

/**
 * Detect file format from extension or content.
 */
function detectFormat(filePath, content) {
  if (argv.format) return argv.format;

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.txt' || ext === '.text') return 'text';

  // Try to auto-detect from content
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  // Check if CSV-like (has commas and multiple lines)
  const lines = trimmed.split('\n');
  if (lines.length > 1 && lines[0].includes(',')) return 'csv';

  return 'text';
}

/**
 * Detect potential encoding issues in a string.
 */
function detectEncodingIssues(content) {
  const issues = [];
  // Check for common mojibake patterns
  if (/\ufffd/.test(content))
    issues.push('Contains Unicode replacement characters (possible encoding corruption)');
  if (/Ã[\x80-\xbf]/.test(content)) issues.push('Possible UTF-8 decoded as Latin-1 (mojibake)');
  if (/\x00/.test(content)) issues.push('Contains null bytes');
  return issues;
}

/**
 * Clean and curate JSON data.
 */
function curateJson(content) {
  const data = JSON.parse(content);
  const records = Array.isArray(data) ? data : [data];
  const originalCount = records.length;
  const issues = [];

  // Track duplicates using JSON serialization
  const seen = new Set();
  const duplicates = [];
  const cleaned = [];
  let nullCount = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    // Count null/undefined values
    if (record === null || record === undefined) {
      nullCount++;
      continue;
    }

    // Check for null fields within objects
    if (typeof record === 'object' && !Array.isArray(record)) {
      for (const [_key, val] of Object.entries(record)) {
        if (val === null || val === undefined || val === '') {
          nullCount++;
        }
      }
    }

    // Deduplicate
    const serialized = JSON.stringify(record);
    if (seen.has(serialized)) {
      duplicates.push(i);
      continue;
    }
    seen.add(serialized);
    cleaned.push(record);
  }

  if (duplicates.length > 0) {
    issues.push(`Found ${duplicates.length} duplicate record(s)`);
  }

  // Detect columns (keys) if array of objects
  let columns = [];
  if (cleaned.length > 0 && typeof cleaned[0] === 'object' && !Array.isArray(cleaned[0])) {
    const allKeys = new Set();
    cleaned.forEach((r) => Object.keys(r).forEach((k) => allKeys.add(k)));
    columns = Array.from(allKeys);
  }

  return {
    records: cleaned,
    originalCount,
    cleanedCount: cleaned.length,
    removed: originalCount - cleaned.length,
    columns,
    qualityReport: { nulls: nullCount, duplicates: duplicates.length, issues },
  };
}

/**
 * Clean and curate CSV data.
 */
function curateCsv(content) {
  const lines = content.split('\n');
  const originalCount = lines.length;
  const issues = [];

  // Remove empty lines and trim whitespace
  let cleaned = lines.map((line) => line.trim()).filter((line) => line.length > 0);

  const emptyRemoved = originalCount - cleaned.length;

  // Deduplicate
  const seen = new Set();
  const duplicates = [];
  const deduped = [];

  for (let i = 0; i < cleaned.length; i++) {
    if (seen.has(cleaned[i])) {
      duplicates.push(i);
    } else {
      seen.add(cleaned[i]);
      deduped.push(cleaned[i]);
    }
  }

  cleaned = deduped;

  if (duplicates.length > 0) {
    issues.push(`Found ${duplicates.length} duplicate line(s)`);
  }
  if (emptyRemoved > 0) {
    issues.push(`Removed ${emptyRemoved} empty line(s)`);
  }

  // Detect columns from header
  let columns = [];
  if (cleaned.length > 0) {
    columns = cleaned[0].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  }

  // Count nulls (empty fields)
  let nullCount = 0;
  for (let i = 1; i < cleaned.length; i++) {
    const fields = cleaned[i].split(',');
    for (const field of fields) {
      if (field.trim() === '' || field.trim().toLowerCase() === 'null') {
        nullCount++;
      }
    }
  }

  return {
    records: cleaned,
    originalCount,
    cleanedCount: cleaned.length,
    removed: originalCount - cleaned.length,
    columns,
    qualityReport: { nulls: nullCount, duplicates: duplicates.length, issues },
  };
}

/**
 * Clean and curate text data.
 */
function curateText(content) {
  const lines = content.split('\n');
  const originalCount = lines.length;
  const issues = [];

  // Remove empty lines and trim whitespace
  let cleaned = lines.map((line) => line.trim()).filter((line) => line.length > 0);

  const emptyRemoved = originalCount - cleaned.length;

  // Deduplicate
  const seen = new Set();
  const duplicates = [];
  const deduped = [];

  for (let i = 0; i < cleaned.length; i++) {
    if (seen.has(cleaned[i])) {
      duplicates.push(i);
    } else {
      seen.add(cleaned[i]);
      deduped.push(cleaned[i]);
    }
  }

  cleaned = deduped;

  if (duplicates.length > 0) {
    issues.push(`Found ${duplicates.length} duplicate line(s)`);
  }
  if (emptyRemoved > 0) {
    issues.push(`Removed ${emptyRemoved} empty line(s)`);
  }

  return {
    records: cleaned,
    originalCount,
    cleanedCount: cleaned.length,
    removed: originalCount - cleaned.length,
    columns: [],
    qualityReport: { nulls: 0, duplicates: duplicates.length, issues },
  };
}

runSkill('dataset-curator', () => {
  const inputPath = validateFilePath(argv.input, 'input');
  const content = fs.readFileSync(inputPath, 'utf8');
  const format = detectFormat(inputPath, content);

  // Detect encoding issues
  const encodingIssues = detectEncodingIssues(content);

  let curateResult;
  switch (format) {
    case 'json':
      curateResult = curateJson(content);
      break;
    case 'csv':
      curateResult = curateCsv(content);
      break;
    case 'text':
    default:
      curateResult = curateText(content);
      break;
  }

  // Add encoding issues to quality report
  if (encodingIssues.length > 0) {
    curateResult.qualityReport.issues.push(...encodingIssues);
  }

  const result = {
    inputFile: inputPath,
    format,
    originalRecords: curateResult.originalCount,
    cleanedRecords: curateResult.cleanedCount,
    removed: curateResult.removed,
    qualityReport: curateResult.qualityReport,
  };

  // Write output if --out provided
  if (argv.out) {
    const outPath = path.resolve(argv.out);
    let outputContent;
    if (format === 'json') {
      outputContent = JSON.stringify(curateResult.records, null, 2);
    } else {
      outputContent = curateResult.records.join('\n') + '\n';
    }
    safeWriteFile(outPath, outputContent, 'utf8');
    result.outputPath = outPath;
  }

  return result;
});
