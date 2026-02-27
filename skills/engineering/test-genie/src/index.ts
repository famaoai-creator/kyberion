import * as path from 'path';
import * as fs from 'fs';
import { runAsyncSkill } from '@agent/core';
import { detectTestRunner, runTests, DEFAULT_CONFIG, TestGenieConfig } from './lib.js';
import yaml from 'js-yaml';

const targetDir = process.argv[2] || '.';
const customCommand = process.argv[3];

// Knowledge layer config logic
const KNOWLEDGE_DIR = path.resolve(__dirname, '../../../knowledge'); // Adjust path for src/index.ts location
const RUNNERS_FILE = path.join(KNOWLEDGE_DIR, 'test-runners/detection.yaml');

function loadConfig(): TestGenieConfig {
  try {
    if (fs.existsSync(RUNNERS_FILE)) {
      return yaml.load(fs.readFileSync(RUNNERS_FILE, 'utf8')) as TestGenieConfig;
    }
  } catch (_e) {
    // ignore
  }
  return DEFAULT_CONFIG;
}

const config = loadConfig();
const RUNNERS = config.runners || DEFAULT_CONFIG.runners;
const EXECUTION_CONFIG = config.execution || DEFAULT_CONFIG.execution;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('test-genie', async () => {
    let testCommand = customCommand;
    let detectedRunner = null;

    if (!testCommand) {
      detectedRunner = detectTestRunner(targetDir, RUNNERS);
      if (detectedRunner) {
        testCommand = detectedRunner.command;
      } else {
        throw new Error('Error: No test runner detected.');
      }
    }

    return runTests(
      targetDir,
      testCommand,
      detectedRunner ? detectedRunner.name : 'custom',
      EXECUTION_CONFIG
    );
  });
}
