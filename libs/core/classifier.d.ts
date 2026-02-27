import { ClassifyRules, ClassifyOptions, ClassifyResult } from './types.js';

export function classify(
  content: string,
  rules: ClassifyRules,
  options?: ClassifyOptions
): ClassifyResult;
export function classifyFile(
  filePath: string,
  rules: ClassifyRules,
  options?: ClassifyOptions
): ClassifyResult;
