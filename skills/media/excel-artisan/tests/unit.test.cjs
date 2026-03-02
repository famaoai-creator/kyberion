/**
 * excel-artisan/tests/unit.test.cjs
 * Self-generated unit test using gemini test-utils.
 */
const { describe, it, assert } = require('@agent/core/test-utils');
const { safeWriteFile, safeUnlinkSync } = require('@agent/core/secure-io');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

describe('Excel Artisan Skill', () => {
  const testHtml = path.join(__dirname, 'test.html');
  const testExcel = path.join(__dirname, 'test.xlsx');

  // Setup
  safeWriteFile(
    testHtml,
    '<table><tr><th>Name</th><th>Value</th></tr><tr><td>Alice</td><td>100</td></tr></table>'
  );

  it('should convert HTML table to Excel file', async () => {
    const scriptPath = path.join(__dirname, '../dist/index.js');
    // Using the combined entry point
    const cmd = `node "${scriptPath}" --action html_to_excel --input "${testHtml}" --out "${testExcel}"`;

    const output = execSync(cmd, { encoding: 'utf8' });
    assert(output.includes('"status": "success"'), 'Output should indicate success');
    assert(fs.existsSync(testExcel), 'Excel file should be created');
  });

  // Cleanup
  setTimeout(() => {
    if (fs.existsSync(testHtml)) safeUnlinkSync(testHtml);
    if (fs.existsSync(testExcel)) safeUnlinkSync(testExcel);
  }, 1000);
});
