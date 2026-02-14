/**
 * excel-artisan/tests/unit.test.cjs
 * Self-generated unit test using gemini test-utils.
 */
const { describe, it, assert } = require('@agent/core/test-utils');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

describe('Excel Artisan Skill', () => {
  const testHtml = path.join(__dirname, 'test.html');
  const testExcel = path.join(__dirname, 'test.xlsx');

  // Setup
  fs.writeFileSync(
    testHtml,
    '<table><tr><th>Name</th><th>Value</th></tr><tr><td>Alice</td><td>100</td></tr></table>'
  );

  it('should convert HTML table to Excel file', async () => {
    const scriptPath = path.join(__dirname, '../scripts/html_to_excel.cjs');
    const cmd = `node "${scriptPath}" "${testHtml}" "${testExcel}"`;

    const output = execSync(cmd, { encoding: 'utf8' });
    assert(output.includes('"status": "success"'), 'Output should indicate success');
    assert(fs.existsSync(testExcel), 'Excel file should be created');
  });

  // Note: Manual cleanup since our tiny helper doesn't have after() yet
  setTimeout(() => {
    if (fs.existsSync(testHtml)) fs.unlinkSync(testHtml);
    if (fs.existsSync(testExcel)) fs.unlinkSync(testExcel);
  }, 1000);
});
