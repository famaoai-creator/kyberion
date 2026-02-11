#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
    .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
    .argv;

const projectDir = path.resolve(argv.dir);

function fileExists(dir, filename) {
    return fs.existsSync(path.join(dir, filename));
}

function readFileContent(dir, filename) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (_err) {
        return null;
    }
}

function detectProjectName(dir) {
    const pkgContent = readFileContent(dir, 'package.json');
    if (pkgContent) {
        try {
            const pkg = JSON.parse(pkgContent);
            if (pkg.name) return pkg.name;
        } catch (_err) { /* ignore parse errors */ }
    }

    // Fall back to directory name
    return path.basename(dir);
}

function detectPrerequisites(dir) {
    const prerequisites = [];

    if (fileExists(dir, 'package.json')) {
        const pkgContent = readFileContent(dir, 'package.json');
        if (pkgContent) {
            try {
                const pkg = JSON.parse(pkgContent);
                if (pkg.engines && pkg.engines.node) {
                    prerequisites.push(`Node.js ${pkg.engines.node}`);
                } else {
                    prerequisites.push('Node.js (version not specified)');
                }
            } catch (_err) {
                prerequisites.push('Node.js');
            }
        }
    }

    if (fileExists(dir, 'requirements.txt') || fileExists(dir, 'setup.py') || fileExists(dir, 'pyproject.toml')) {
        prerequisites.push('Python');
    }

    if (fileExists(dir, 'go.mod')) {
        prerequisites.push('Go');
    }

    if (fileExists(dir, 'Cargo.toml')) {
        prerequisites.push('Rust / Cargo');
    }

    if (fileExists(dir, 'Gemfile')) {
        prerequisites.push('Ruby / Bundler');
    }

    if (fileExists(dir, 'docker-compose.yml') || fileExists(dir, 'docker-compose.yaml') || fileExists(dir, 'Dockerfile')) {
        prerequisites.push('Docker');
    }

    if (fileExists(dir, 'Makefile')) {
        prerequisites.push('Make');
    }

    if (prerequisites.length === 0) {
        prerequisites.push('No specific prerequisites detected');
    }

    return prerequisites;
}

function generateSetupSteps(dir) {
    const steps = [];

    steps.push('1. Clone the repository');

    if (fileExists(dir, '.env.example')) {
        steps.push('2. Copy `.env.example` to `.env` and fill in required values');
    }

    if (fileExists(dir, 'package.json')) {
        const pkgContent = readFileContent(dir, 'package.json');
        const hasYarnLock = fileExists(dir, 'yarn.lock');
        const hasPnpmLock = fileExists(dir, 'pnpm-lock.yaml');

        if (hasPnpmLock) {
            steps.push(`${steps.length + 1}. Install dependencies: \`pnpm install\``);
        } else if (hasYarnLock) {
            steps.push(`${steps.length + 1}. Install dependencies: \`yarn install\``);
        } else {
            steps.push(`${steps.length + 1}. Install dependencies: \`npm install\``);
        }

        if (pkgContent) {
            try {
                const pkg = JSON.parse(pkgContent);
                if (pkg.scripts) {
                    if (pkg.scripts.dev) {
                        steps.push(`${steps.length + 1}. Start dev server: \`npm run dev\``);
                    } else if (pkg.scripts.start) {
                        steps.push(`${steps.length + 1}. Start application: \`npm start\``);
                    }
                    if (pkg.scripts.test) {
                        steps.push(`${steps.length + 1}. Run tests: \`npm test\``);
                    }
                }
            } catch (_err) { /* ignore parse errors */ }
        }
    }

    if (fileExists(dir, 'requirements.txt')) {
        steps.push(`${steps.length + 1}. Install Python dependencies: \`pip install -r requirements.txt\``);
    }

    if (fileExists(dir, 'docker-compose.yml') || fileExists(dir, 'docker-compose.yaml')) {
        steps.push(`${steps.length + 1}. Start services: \`docker-compose up\``);
    }

    if (fileExists(dir, 'Makefile')) {
        steps.push(`${steps.length + 1}. See available commands: \`make help\` or review the Makefile`);
    }

    return steps;
}

function identifyKeyFiles(dir) {
    const keyFiles = [];
    const candidates = [
        { file: 'README.md', reason: 'Project overview and documentation' },
        { file: 'CONTRIBUTING.md', reason: 'Contribution guidelines' },
        { file: 'package.json', reason: 'Project metadata and scripts' },
        { file: '.env.example', reason: 'Environment variable reference' },
        { file: 'docker-compose.yml', reason: 'Service architecture' },
        { file: 'docker-compose.yaml', reason: 'Service architecture' },
        { file: 'Makefile', reason: 'Build and task automation' },
        { file: 'Dockerfile', reason: 'Container build configuration' },
        { file: 'tsconfig.json', reason: 'TypeScript configuration' },
        { file: '.eslintrc.json', reason: 'Linting rules' },
        { file: '.eslintrc.js', reason: 'Linting rules' },
        { file: 'jest.config.js', reason: 'Test configuration' },
        { file: 'vitest.config.ts', reason: 'Test configuration' },
    ];

    for (const candidate of candidates) {
        if (fileExists(dir, candidate.file)) {
            keyFiles.push(candidate);
        }
    }

    // Detect source directories
    const srcDirs = ['src', 'lib', 'app', 'pages', 'components'];
    for (const srcDir of srcDirs) {
        const fullPath = path.join(dir, srcDir);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
            keyFiles.push({ file: `${srcDir}/`, reason: 'Source code directory' });
        }
    }

    return keyFiles;
}

function generateQuickStart(projectName, steps) {
    const lines = [`# Quick Start for ${projectName}`, ''];
    for (const step of steps) {
        lines.push(step);
    }
    return lines.join('\n');
}

runSkill('onboarding-wizard', () => {
    if (!fs.existsSync(projectDir)) {
        throw new Error(`Directory does not exist: ${projectDir}`);
    }

    const projectName = detectProjectName(projectDir);
    const prerequisites = detectPrerequisites(projectDir);
    const setupSteps = generateSetupSteps(projectDir);
    const keyFiles = identifyKeyFiles(projectDir);
    const quickStart = generateQuickStart(projectName, setupSteps);

    return {
        projectName,
        prerequisites,
        setupSteps,
        keyFiles,
        quickStart,
    };
});
