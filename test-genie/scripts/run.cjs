const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const glob = require('glob');
const { runAsyncSkill } = require('@agent/core');

const targetDir = process.argv[2] || '.';
const customCommand = process.argv[3];

// --- Knowledge Layer Paths ---
const KNOWLEDGE_DIR = path.join(__dirname, '../../knowledge');
const RUNNERS_FILE = path.join(KNOWLEDGE_DIR, 'test-runners/detection.yaml');

// --- Load Configuration from Knowledge Layer ---

function loadConfig() {
  try {
    return yaml.load(fs.readFileSync(RUNNERS_FILE, 'utf8'));
  } catch (_e) {
    return {
      runners: [
        {
          name: 'npm test',
          detection: [{ type: 'package_json_script', script: 'test' }],
          command: 'npm test',
        },
        {
          name: 'pytest',
          detection: [{ type: 'file_exists', path: 'pytest.ini' }],
          command: 'pytest',
        },
      ],
      execution: { max_buffer: 5242880, timeout: 300000 },
    };
  }
}

const config = loadConfig();
const RUNNERS = config.runners || [];
const EXECUTION_CONFIG = config.execution || { max_buffer: 5242880, timeout: 300000 };

// --- Detection Logic ---

function checkDetection(detection, dir) {
  switch (detection.type) {
    case 'file_exists':
      return fs.existsSync(path.join(dir, detection.path));

    case 'directory_exists': {
      const dirPath = path.join(dir, detection.path);
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    }

    case 'file_pattern':
      try {
        const matches = glob.sync(detection.pattern, { cwd: dir, nodir: true });
        return matches.length > 0;
      } catch (_e) {
        return false;
      }

    case 'package_json_script':
      try {
        const pkgPath = path.join(dir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return pkg.scripts && pkg.scripts[detection.script];
      } catch (_e) {
        return false;
      }

    case 'package_json_dep':
      try {
        const pkgPath = path.join(dir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        return Object.keys(allDeps).some((d) => d.includes(detection.dependency));
      } catch (_e) {
        return false;
      }

    default:
      return false;
  }
}

function detectTestRunner(dir) {
  for (const runner of RUNNERS) {
    const detections = runner.detection || [];
    const isDetected = detections.some((d) => checkDetection(d, dir));
    if (isDetected) {
      return runner;
    }
  }
  return null;
}

// --- Main ---

let testCommand = customCommand;
let detectedRunner = null;

if (!testCommand) {
  detectedRunner = detectTestRunner(targetDir);
  if (detectedRunner) {
    testCommand = detectedRunner.command;
  } else {
    console.error('Error: No test runner detected.');
    process.exit(1);
  }
}

runAsyncSkill('test-genie', async () => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    exec(
      testCommand,
      {
        cwd: targetDir,
        maxBuffer: EXECUTION_CONFIG.max_buffer,
        timeout: EXECUTION_CONFIG.timeout,
      },
      (error, stdout, stderr) => {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        const result = {
          targetDir: path.resolve(targetDir),
          runner: detectedRunner ? detectedRunner.name : 'custom',
          command: testCommand,
          duration: parseFloat(duration),
          success: !error,
          exitCode: error ? error.code : 0,
          stdout,
          stderr: stderr || undefined,
        };

        if (error) {
          reject(
            Object.assign(new Error(`Test failed with exit code ${error.code}`), { data: result })
          );
        } else {
          resolve(result);
        }
      }
    );
  });
});
