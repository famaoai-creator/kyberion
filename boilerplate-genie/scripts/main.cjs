#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { requireArgs } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
  .option('name', { alias: 'n', type: 'string', describe: 'Project name', demandOption: true })
  .option('type', {
    alias: 'T',
    type: 'string',
    choices: ['node', 'python', 'generic'],
    describe: 'Project type',
    demandOption: true,
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    describe: 'Output directory (defaults to ./<name>)',
  }).argv;

/**
 * Validate and resolve the output directory path.
 * Creates the directory if it does not exist.
 * @param {string} dirPath - Directory path to validate/create
 * @param {string} label - Label for error messages
 * @returns {string} Resolved absolute path
 */
function validateDirPath(dirPath, label = 'directory') {
  if (!dirPath) {
    throw new Error(`Missing required ${label} path`);
  }
  const resolved = path.resolve(dirPath);
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Write a file to disk, creating parent directories as needed.
 * @param {string} filePath - Absolute path to the file
 * @param {string} content - File content
 */
function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, content, 'utf8');
}

// --- Template generators ---

function generateNodeProject(name, outDir) {
  const files = [];

  // package.json
  const pkg = {
    name,
    version: '1.0.0',
    description: '',
    main: 'src/index.js',
    scripts: {
      start: 'node src/index.js',
      test: 'jest',
      lint: 'eslint src/',
    },
    keywords: [],
    license: 'MIT',
    devDependencies: {
      jest: '^29.0.0',
      eslint: '^8.0.0',
    },
  };
  writeFile(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  files.push('package.json');

  // README.md
  writeFile(
    path.join(outDir, 'README.md'),
    `# ${name}\n\nA Node.js project.\n\n## Getting Started\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\`\n\n## Testing\n\n\`\`\`bash\nnpm test\n\`\`\`\n`
  );
  files.push('README.md');

  // .gitignore
  writeFile(path.join(outDir, '.gitignore'), `node_modules/\ndist/\ncoverage/\n.env\n*.log\n`);
  files.push('.gitignore');

  // src/index.js
  writeFile(
    path.join(outDir, 'src', 'index.js'),
    `'use strict';\n\nconsole.log('Hello from ${name}!');\n`
  );
  files.push('src/index.js');

  // tests/index.test.js
  writeFile(
    path.join(outDir, 'tests', 'index.test.js'),
    `'use strict';\n\ndescribe('${name}', () => {\n  test('should pass', () => {\n    expect(true).toBe(true);\n  });\n});\n`
  );
  files.push('tests/index.test.js');

  // .github/workflows/ci.yml
  const ciYaml = `name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '20'\n      - run: npm install\n      - run: npm test\n      - run: npm run lint\n`;
  writeFile(path.join(outDir, '.github', 'workflows', 'ci.yml'), ciYaml);
  files.push('.github/workflows/ci.yml');

  return files;
}

function generatePythonProject(name, outDir) {
  const files = [];
  const pyName = name.replace(/-/g, '_');

  // setup.py
  const setupPy = `from setuptools import setup, find_packages\n\nsetup(\n    name='${name}',\n    version='1.0.0',\n    packages=find_packages(where='src'),\n    package_dir={'': 'src'},\n    python_requires='>=3.8',\n    install_requires=[],\n    extras_require={\n        'dev': ['pytest', 'flake8'],\n    },\n)\n`;
  writeFile(path.join(outDir, 'setup.py'), setupPy);
  files.push('setup.py');

  // README.md
  writeFile(
    path.join(outDir, 'README.md'),
    `# ${name}\n\nA Python project.\n\n## Getting Started\n\n\`\`\`bash\npip install -e .[dev]\npython -m ${pyName}\n\`\`\`\n\n## Testing\n\n\`\`\`bash\npytest\n\`\`\`\n`
  );
  files.push('README.md');

  // .gitignore
  writeFile(
    path.join(outDir, '.gitignore'),
    `__pycache__/\n*.pyc\n*.egg-info/\ndist/\nbuild/\n.env\n.venv/\n*.log\n.pytest_cache/\n`
  );
  files.push('.gitignore');

  // src/<pyName>/__init__.py
  writeFile(path.join(outDir, 'src', pyName, '__init__.py'), `"""${name} package."""\n`);
  files.push(`src/${pyName}/__init__.py`);

  // src/<pyName>/__main__.py
  writeFile(
    path.join(outDir, 'src', pyName, '__main__.py'),
    `"""Main entry point for ${name}."""\n\n\ndef main():\n    print('Hello from ${name}!')\n\n\nif __name__ == '__main__':\n    main()\n`
  );
  files.push(`src/${pyName}/__main__.py`);

  // tests/test_main.py
  writeFile(
    path.join(outDir, 'tests', 'test_main.py'),
    `"""Tests for ${name}."""\n\n\ndef test_placeholder():\n    assert True\n`
  );
  files.push('tests/test_main.py');

  // .github/workflows/ci.yml
  const ciYaml = `name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.11'\n      - run: pip install -e .[dev]\n      - run: pytest\n      - run: flake8 src/\n`;
  writeFile(path.join(outDir, '.github', 'workflows', 'ci.yml'), ciYaml);
  files.push('.github/workflows/ci.yml');

  return files;
}

function generateGenericProject(name, outDir) {
  const files = [];

  // README.md
  writeFile(
    path.join(outDir, 'README.md'),
    `# ${name}\n\nA project.\n\n## Getting Started\n\nSee the \`src/\` directory for source files.\n\n## Testing\n\nSee the \`tests/\` directory for test files.\n`
  );
  files.push('README.md');

  // .gitignore
  writeFile(path.join(outDir, '.gitignore'), `.env\n*.log\ndist/\nbuild/\ntmp/\n`);
  files.push('.gitignore');

  // src/.gitkeep
  writeFile(path.join(outDir, 'src', '.gitkeep'), '');
  files.push('src/.gitkeep');

  // tests/.gitkeep
  writeFile(path.join(outDir, 'tests', '.gitkeep'), '');
  files.push('tests/.gitkeep');

  // Makefile
  writeFile(
    path.join(outDir, 'Makefile'),
    `# ${name} Makefile\n\n.PHONY: build test clean\n\nbuild:\n\t@echo "Build step (customize this)"\n\ntest:\n\t@echo "Test step (customize this)"\n\nclean:\n\t@echo "Clean step (customize this)"\n`
  );
  files.push('Makefile');

  // .github/workflows/ci.yml
  const ciYaml = `name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: make build\n      - run: make test\n`;
  writeFile(path.join(outDir, '.github', 'workflows', 'ci.yml'), ciYaml);
  files.push('.github/workflows/ci.yml');

  return files;
}

// --- Main ---

runSkill('boilerplate-genie', () => {
  requireArgs(argv, ['name', 'type']);

  const projectName = argv.name;
  const projectType = argv.type;
  const outDir = validateDirPath(argv.out || path.resolve(projectName), 'output directory');

  // Create the output directory
  fs.mkdirSync(outDir, { recursive: true });

  let files;
  switch (projectType) {
    case 'node':
      files = generateNodeProject(projectName, outDir);
      break;
    case 'python':
      files = generatePythonProject(projectName, outDir);
      break;
    case 'generic':
      files = generateGenericProject(projectName, outDir);
      break;
    default:
      throw new Error(`Unsupported project type: ${projectType}`);
  }

  return {
    name: projectName,
    type: projectType,
    files,
    directory: outDir,
  };
});
