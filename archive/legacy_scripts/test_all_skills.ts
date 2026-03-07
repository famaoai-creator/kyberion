import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeWriteFile, safeMkdir } from '@agent/core';

const rootDir = process.cwd();
const workDir = path.join(rootDir, 'work', 'test_run');

if (!fs.existsSync(workDir)) {
  fs.mkdirSync(workDir, { recursive: true });
}

let passed = 0;
let failed = 0;

function runTest(name: string, command: string, checkFile: string | null = null, expectError: boolean = false): void {
  process.stdout.write(`Testing [${name.padEnd(25)}]... `);
  try {
    execSync(command, { cwd: rootDir, stdio: 'pipe' });

    if (expectError) {
      console.log('❌ FAIL (Expected error but succeeded)');
      failed++;
      return;
    }

    if (checkFile && !fs.existsSync(checkFile)) {
      throw new Error(`Output file not created: ${checkFile}`);
    }

    console.log('✅ PASS');
    passed++;
  } catch (e: any) {
    if (expectError) {
      console.log('✅ PASS (Expected Failure verified)');
      passed++;
    } else {
      console.log('❌ FAIL');
      console.error(`  Error: ${e.message}`);
      if (e.stdout && e.stdout.toString().trim()) {
        console.log(`  Stdout: ${e.stdout.toString().trim()}`);
      }
      if (e.stderr && e.stderr.toString().trim()) {
        console.log(`  Stderr: ${e.stderr.toString().trim()}`);
      }
      failed++;
    }
  }
}

// --- Prepare Test Data using safeWriteFile ---
const csvFile = path.join(workDir, 'data.csv');
safeWriteFile(csvFile, 'id,name\n1,Gemini\n2,User');

const mdFile = path.join(workDir, 'doc.md');
safeWriteFile(mdFile, '# Test Document\n\nThis is a test.');

const templateFile = path.join(workDir, 'template.ejs');
safeWriteFile(templateFile, 'Hello {{name}}!');

const dataObjFile = path.join(workDir, 'obj.json');
safeWriteFile(dataObjFile, '{"name": "Gemini"}');

const codeFile = path.join(workDir, 'app.js');
safeWriteFile(codeFile, 'function main() { console.log("Hello"); } main();');

const piiFile = path.join(workDir, 'pii.txt');
safeWriteFile(piiFile, 'Contact: test@example.com, Phone: 03-1234-5678');

const glossaryFile = path.join(workDir, 'glossary.json');
safeWriteFile(glossaryFile, '{"Gemini": "AI Agent"}');

const schemaFile = path.join(workDir, 'schema.json');
safeWriteFile(
  schemaFile,
  JSON.stringify({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] })
);

const dummyAudio = path.join(workDir, 'test.mp3');
safeWriteFile(dummyAudio, 'dummy audio content');

// Helper to get executable path (prefer dist/index.js)
function getSkillCmd(skillName: string, subPath: string = 'dist/index.js'): string {
  const fullPath = path.join(rootDir, 'skills', '*', skillName, subPath);
  // Simple glob-like resolution for test runner
  const match = execSync(`ls ${fullPath} 2>/dev/null`).toString().trim().split('\n')[0];
  return match ? `node "${match}"` : `node dist/scripts/cli.js run ${skillName}`;
}

async function main(): Promise<void> {
  console.log('\n=== Starting Ecosystem Skill Tests ===\n');

  // 1. Data Transformer
  const jsonFile = path.join(workDir, 'data.json');
  runTest(
    'data-transformer',
    `${getSkillCmd('data-transformer')} -i "${csvFile}" -t json -o "${jsonFile}"`,
    jsonFile
  );

  // 2. Glossary Resolver
  runTest(
    'glossary-resolver',
    `${getSkillCmd('glossary-resolver')} -i "${mdFile}" -g "${glossaryFile}" -o "${path.join(workDir, 'resolved.txt')}"`
  );

  // 3. Format Detector
  runTest('format-detector', `${getSkillCmd('format-detector')} -i "${jsonFile}"`);

  // 4. Intent Classifier
  runTest('intent-classifier', `${getSkillCmd('intent-classifier')} -i "${mdFile}"`);

  // 5. Sensitivity Detector
  runTest('sensitivity-detector', `${getSkillCmd('sensitivity-detector')} -i "${piiFile}"`);

  console.log('\n=== FINAL RESULT ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
