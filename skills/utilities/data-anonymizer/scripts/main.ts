import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';

/**
 * Recursively masks sensitive fields in a JSON object.
 */
function anonymize(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(anonymize);
  } else if (obj !== null && typeof obj === 'object') {
    const maskedObj: any = {};
    const SENSITIVE_KEYS = [
      'email',
      'password',
      'token',
      'secret',
      'key',
      'apiKey',
      'api_key',
      'auth',
    ];

    for (const [key, value] of Object.entries(obj)) {
      const matchesSensitive = SENSITIVE_KEYS.some((sk) =>
        key.toLowerCase().includes(sk.toLowerCase())
      );

      if (matchesSensitive && typeof value === 'string') {
        maskedObj[key] = '***MASKED***';
      } else {
        maskedObj[key] = anonymize(value);
      }
    }
    return maskedObj;
  }
  return obj;
}

runSkill('data-anonymizer', () => {
  const argv = process.argv.slice(2);
  const args = {
    input: argv.find((a: string) => !a.startsWith('--')),
    out: argv.indexOf('--out') !== -1 ? argv[argv.indexOf('--out') + 1] : undefined,
  };

  if (!args.input) {
    throw new Error('Input file path is required');
  }

  const inputPath = path.resolve(args.input);
  const rawData = safeReadFile(inputPath, 'utf8') as string;
  const jsonData = JSON.parse(rawData);

  process.stderr.write(`[Anonymizer] Processing ${inputPath}...\n`);
  const anonymizedData = anonymize(jsonData);

  if (args.out) {
    const outputPath = path.resolve(args.out);
    safeWriteFile(outputPath, JSON.stringify(anonymizedData, null, 2));
    return {
      status: 'success',
      output: outputPath,
      message: 'Sensitive data masked successfully.',
    };
  }

  return { status: 'success', data: anonymizedData };
});
