const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { globSync } = require('glob');

const targetDir = process.argv[2] || '.';
const customCommand = process.argv[3];

// --- Knowledge Layer Paths ---
const KNOWLEDGE_DIR = path.join(__dirname, '../../knowledge');
const RUNNERS_FILE = path.join(KNOWLEDGE_DIR, 'test-runners/detection.yaml');

// --- Load Configuration from Knowledge Layer ---

function loadConfig() {
  try {
    return yaml.load(fs.readFileSync(RUNNERS_FILE, 'utf8'));
  } catch (e) {
    console.error(chalk.yellow(`Warning: Could not load config from ${RUNNERS_FILE}: ${e.message}`));
    // Fallback to basic config
    return {
      runners: [
        { name: 'npm test', detection: [{ type: 'package_json_script', script: 'test' }], command: 'npm test' },
        { name: 'pytest', detection: [{ type: 'file_exists', path: 'pytest.ini' }], command: 'pytest' }
      ],
      execution: { max_buffer: 5242880, timeout: 300000 }
    };
  }
}

const config = loadConfig();
const RUNNERS = config.runners || [];
const EXECUTION_CONFIG = config.execution || { max_buffer: 5242880, timeout: 300000 };

// --- Detection Logic ---

function checkDetection(detection, targetDir) {
  switch (detection.type) {
    case 'file_exists':
      return fs.existsSync(path.join(targetDir, detection.path));

    case 'directory_exists':
      const dirPath = path.join(targetDir, detection.path);
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();

    case 'file_pattern':
      try {
        const matches = globSync(detection.pattern, { cwd: targetDir, nodir: true });
        return matches.length > 0;
      } catch (e) {
        return false;
      }

    case 'package_json_script':
      try {
        const pkgPath = path.join(targetDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return pkg.scripts && pkg.scripts[detection.script];
      } catch (e) {
        return false;
      }

    case 'package_json_dep':
      try {
        const pkgPath = path.join(targetDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        return Object.keys(allDeps).some(d => d.includes(detection.dependency));
      } catch (e) {
        return false;
      }

    default:
      return false;
  }
}

function detectTestRunner(targetDir) {
  for (const runner of RUNNERS) {
    const detections = runner.detection || [];
    const isDetected = detections.some(d => checkDetection(d, targetDir));
    if (isDetected) {
      return runner;
    }
  }
  return null;
}

// --- Main ---

console.log(chalk.bold.cyan('\n🧪 Test Genie\n'));
console.log(chalk.gray(`Target directory: ${path.resolve(targetDir)}`));

let testCommand = customCommand;
let detectedRunner = null;

if (!testCommand) {
  detectedRunner = detectTestRunner(targetDir);
  if (detectedRunner) {
    testCommand = detectedRunner.command;
    console.log(chalk.green(`Detected: ${detectedRunner.name}`));
    if (detectedRunner.description) {
      console.log(chalk.gray(`  ${detectedRunner.description}`));
    }
  } else {
    console.log(chalk.red('Error: No test runner detected.'));
    console.log(chalk.yellow('Please provide a custom command: node run.cjs <dir> <command>'));
    console.log(chalk.gray('\nSupported runners:'));
    RUNNERS.forEach(r => {
      console.log(chalk.gray(`  - ${r.name} (${r.language || 'unknown'})`));
    });
    process.exit(1);
  }
} else {
  console.log(chalk.cyan(`Using custom command: ${testCommand}`));
}

console.log(chalk.gray(`\nRunning: ${testCommand}\n`));
console.log(chalk.gray('---------------------------------------------------'));

const startTime = Date.now();

exec(testCommand, {
  cwd: targetDir,
  maxBuffer: EXECUTION_CONFIG.max_buffer,
  timeout: EXECUTION_CONFIG.timeout
}, (error, stdout, stderr) => {
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("\n--- TEST OUTPUT (STDOUT) ---\n");
  console.log(stdout);

  if (stderr) {
    console.log("\n--- TEST ERRORS (STDERR) ---\n");
    console.log(stderr);
  }

  console.log(chalk.gray('---------------------------------------------------'));
  console.log(chalk.gray(`Duration: ${duration}s`));

  if (error) {
    console.log(chalk.red.bold(`\n✘ TEST FAILED (Exit code: ${error.code})`));
    process.exit(error.code || 1);
  } else {
    console.log(chalk.green.bold(`\n✔ TEST PASSED`));
  }

  // Output JSON report if requested
  if (process.argv.includes('--json')) {
    const report = {
      timestamp: new Date().toISOString(),
      targetDir: path.resolve(targetDir),
      runner: detectedRunner ? detectedRunner.name : 'custom',
      command: testCommand,
      duration: parseFloat(duration),
      success: !error,
      exitCode: error ? error.code : 0
    };
    console.log('\n' + JSON.stringify(report, null, 2));
  }
});
