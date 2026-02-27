import * as fs from 'fs';
import * as path from 'path';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeExec } from '@agent/core/secure-io';

export interface ProjectAnalysis {
  entryPoints: string[];
  dependencies: number;
  scripts: string[];
  languages: Record<string, number>;
}

export interface BuildPlan {
  tool: string;
  command: string;
  output: string;
  prerequisites: string[];
}

export interface ToolchainCheck {
  node?: string;
  npm?: string;
  go?: string;
  rust?: string;
  docker?: string;
}

export interface CompilerResult {
  directory: string;
  target: string;
  mode: string;
  projectAnalysis: ProjectAnalysis;
  buildPlan: BuildPlan;
  toolchain: ToolchainCheck;
  recommendations: string[];
}

export function analyzeProject(dir: string): ProjectAnalysis {
  const analysis: ProjectAnalysis = {
    entryPoints: [],
    dependencies: 0,
    scripts: [],
    languages: {},
  };
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(safeReadFile(pkgPath, 'utf8'));
      if (pkg.main) analysis.entryPoints.push(pkg.main);
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? { default: pkg.bin } : pkg.bin;
        analysis.entryPoints.push(...(Object.values(bins) as string[]));
      }
      analysis.dependencies = Object.keys(pkg.dependencies || {}).length;
      analysis.scripts = Object.keys(pkg.scripts || {});
    } catch (_e) {
      // ignore
    }
  }

  const allFiles = getAllFiles(dir, { maxDepth: 3 });
  for (const full of allFiles) {
    const ext = path.extname(full);
    if (['.js', '.cjs', '.ts', '.go', '.rs', '.py'].includes(ext)) {
      analysis.languages[ext] = (analysis.languages[ext] || 0) + 1;
    }
  }
  return analysis;
}

export function generateBuildPlan(analysis: ProjectAnalysis, target: string): BuildPlan {
  const plans: Record<string, BuildPlan> = {
    node: {
      tool: 'pkg or nexe',
      command: `npx pkg ${analysis.entryPoints[0] || 'index.js'} --targets node18-linux-x64,node18-macos-x64,node18-win-x64`,
      output: 'dist/',
      prerequisites: ['npm install --production'],
    },
    go: {
      tool: 'Go compiler',
      command: 'GOOS=linux GOARCH=amd64 go build -o dist/app .',
      output: 'dist/app',
      prerequisites: ['go mod tidy'],
    },
    rust: {
      tool: 'Cargo',
      command: 'cargo build --release --target x86_64-unknown-linux-gnu',
      output: 'target/release/',
      prerequisites: ['cargo check'],
    },
    docker: {
      tool: 'Docker',
      command: `docker build -t app:latest .`,
      output: 'Docker image',
      prerequisites: ['Dockerfile must exist'],
    },
  };
  return plans[target] || plans['node'];
}

export function checkToolchain(target: string): ToolchainCheck {
  const checks: ToolchainCheck = {};
  try {
    if (target === 'node') {
      checks.node = safeExec('node', ['--version']).trim();
      checks.npm = safeExec('npm', ['--version']).trim();
    }
    if (target === 'go') {
      try {
        checks.go = safeExec('go', ['version']).trim();
      } catch (_e) {
        checks.go = 'not installed';
      }
    }
    if (target === 'rust') {
      try {
        checks.rust = safeExec('rustc', ['--version']).trim();
      } catch (_e) {
        checks.rust = 'not installed';
      }
    }
    if (target === 'docker') {
      try {
        checks.docker = safeExec('docker', ['--version']).trim();
      } catch (_e) {
        checks.docker = 'not installed';
      }
    }
  } catch (_e) {
    // ignore
  }
  return checks;
}

export function runCompiler(dir: string, target: string, dryRun: boolean): CompilerResult {
  const analysis = analyzeProject(dir);
  const buildPlan = generateBuildPlan(analysis, target);
  const toolchain = checkToolchain(target);

  return {
    directory: dir,
    target: target,
    mode: dryRun ? 'dry-run' : 'compile',
    projectAnalysis: analysis,
    buildPlan,
    toolchain,
    recommendations: [
      analysis.entryPoints.length === 0
        ? '[warn] No entry point found - specify in package.json "main" or "bin"'
        : `Entry: ${analysis.entryPoints[0]}`,
      `Dependencies: ${analysis.dependencies} (will be bundled)`,
    ],
  };
}
