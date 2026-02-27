import * as fs from 'node:fs';

export interface TailResult {
  logFile: string;
  totalSize: number;
  linesReturned: number;
  content: string;
}

export function tailFile(logFile: string, linesToRead: number): TailResult {
  const stats = fs.statSync(logFile);
  const fileSize = stats.size;
  const bufferSize = 1024 * 100;
  const buffer = Buffer.alloc(bufferSize);

  const fd = fs.openSync(logFile, 'r');
  const start = Math.max(0, fileSize - bufferSize);
  const bytesToRead = Math.min(bufferSize, fileSize);

  const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
  fs.closeSync(fd);

  const content = buffer.toString('utf8', 0, bytesRead);
  const lines = content.split(new RegExp('\\\\r?\\\\n'));
  const lastLines = lines.slice(-linesToRead);

  return {
    logFile,
    totalSize: fileSize,
    linesReturned: lastLines.length,
    content: lastLines.join(String.fromCharCode(10)),
  };
}

export interface LogValidation {
  totalLines: number;
  validJsonCount: number;
  invalidLines: string[];
  missingFields: Record<string, number>;
}

/**
 * Validates that log lines are structured JSON and contain required fields.
 */
export function validateLogStructure(content: string): LogValidation {
  const lines = content.split('\n').filter(Boolean);
  const result: LogValidation = {
    totalLines: lines.length,
    validJsonCount: 0,
    invalidLines: [],
    missingFields: {}
  };

  const requiredFields = ['timestamp', 'level', 'message'];

  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      result.validJsonCount++;
      
      for (const field of requiredFields) {
        if (!json[field]) {
          result.missingFields[field] = (result.missingFields[field] || 0) + 1;
        }
      }
    } catch (e) {
      result.invalidLines.push(line.substring(0, 100));
    }
  }

  return result;
}
