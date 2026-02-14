#!/usr/bin/env node
/**
 * doc-to-text/scripts/extract.cjs
 * Modernized Document Extractor using @agent/core.
 */

const { runSkillAsync } = require('@agent/core');
const { requireArgs, validateFilePath } = require('@agent/core/validators');
const fs = require('fs');
const path = require('path');
const textract = require('textract'); // Assuming textract is used based on skill name

runSkillAsync('doc-to-text', async () => {
  const argv = requireArgs(['input']);
  const inputPath = validateFilePath(argv.input, 'input file');

  return new Promise((resolve, reject) => {
    textract.fromFileWithPath(inputPath, (error, text) => {
      if (error) {
        return reject(new Error(`Extraction failed: ${error.message}`));
      }
      resolve({
        file: argv.input,
        length: text.length,
        content: text,
      });
    });
  });
});
