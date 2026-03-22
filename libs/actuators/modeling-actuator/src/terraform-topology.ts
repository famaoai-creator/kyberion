import * as path from 'node:path';
import { safeExistsSync, safeLstat, safeReadFile, safeReaddir, safeStat } from '@agent/core';
import type { TerraformBlock, TerraformTopologyIr } from './topology-ir.js';

function shouldSkipTerraformDir(name: string): boolean {
  return ['.git', '.terraform', '.terragrunt-cache', 'node_modules'].includes(name);
}

function listTfFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of safeReaddir(dir)) {
    if (shouldSkipTerraformDir(name)) continue;
    const abs = path.join(dir, name);
    const stat = safeLstat(abs);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...listTfFiles(abs));
    else if (stat.isFile() && abs.endsWith('.tf')) out.push(abs);
  }
  return out.sort();
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function parseBlocks(filePath: string, exampleRoot: string): TerraformBlock[] {
  const content = String(safeReadFile(filePath, { encoding: 'utf8' }));
  const blocks: TerraformBlock[] = [];
  const blockRegex = /(provider|resource|data|module|output|variable|terraform)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/g;
  for (const match of content.matchAll(blockRegex)) {
    const openIndex = (match.index || 0) + match[0].length - 1;
    const closeIndex = findMatchingBrace(content, openIndex);
    const body = content.slice(openIndex + 1, closeIndex);
    const kind = match[1];
    const type = match[2];
    const name = match[3] || '';
    const relDir = path.relative(exampleRoot, path.dirname(filePath)).replaceAll(path.sep, '/') || '.';
    const baseId =
      kind === 'resource' ? `resource.${type}.${name}` :
      kind === 'data' ? `data.${type}.${name}` :
      kind === 'module' ? `module.${type}` :
      kind === 'provider' ? `provider.${type}` :
      kind === 'terraform' ? 'terraform.root' :
      kind === 'output' ? `output.${type}` :
      `variable.${type}`;
    blocks.push({ kind, type, name, id: `${relDir}::${baseId}`, dir: relDir, body, filePath });
  }

  for (const block of blocks.filter((item) => item.kind === 'terraform')) {
    for (const backendMatch of block.body.matchAll(/backend\s+"([^"]+)"\s*\{/g)) {
      blocks.push({
        kind: 'backend',
        type: backendMatch[1],
        name: '',
        id: `${block.dir}::backend.${backendMatch[1]}`,
        dir: block.dir,
        body: block.body,
        filePath: block.filePath,
      });
    }
  }

  return blocks;
}

function resolveModuleSourceDir(block: TerraformBlock, exampleRoot: string): string | null {
  if (block?.kind !== 'module') return null;
  const sourceMatch = String(block.body || '').match(/source\s*=\s*"([^"]+)"/);
  if (!sourceMatch) return null;
  const sourceDir = path.normalize(path.join(path.dirname(block.filePath), sourceMatch[1]));
  return path.relative(exampleRoot, sourceDir).replaceAll(path.sep, '/');
}

function collectModuleSourceDirs(exampleRoot: string, blocks: TerraformBlock[]): string[] {
  const dirs = new Set<string>();
  for (const block of blocks) {
    const relSourceDir = resolveModuleSourceDir(block, exampleRoot);
    if (relSourceDir) dirs.add(relSourceDir);
  }
  return [...dirs].sort();
}

function collectExternalModuleSourceBlocks(exampleRoot: string, rootBlocks: TerraformBlock[]): TerraformBlock[] {
  const moduleSourceDirs = collectModuleSourceDirs(exampleRoot, rootBlocks);
  const blocks: TerraformBlock[] = [];
  for (const relSourceDir of moduleSourceDirs) {
    const absSourceDir = path.resolve(exampleRoot, relSourceDir);
    if (!safeExistsSync(absSourceDir) || !safeStat(absSourceDir).isDirectory()) continue;
    for (const filePath of listTfFiles(absSourceDir)) {
      blocks.push(...parseBlocks(filePath, exampleRoot));
    }
  }
  return blocks;
}

function isWithinModuleSourceDir(dir: string, moduleSourceDirs: string[]): boolean {
  return moduleSourceDirs.some((sourceDir) => dir === sourceDir || dir.startsWith(`${sourceDir}/`));
}

function toCallerBlocksBySource(
  exampleRoot: string,
  runtimeBlocks: TerraformBlock[],
): Record<string, TerraformBlock[]> {
  const buckets = new Map<string, TerraformBlock[]>();
  for (const block of runtimeBlocks.filter((item) => item.kind === 'module')) {
    const relSourceDir = resolveModuleSourceDir(block, exampleRoot);
    if (!relSourceDir) continue;
    const current = buckets.get(relSourceDir) || [];
    current.push(block);
    buckets.set(relSourceDir, current);
  }
  return Object.fromEntries([...buckets.entries()].map(([key, value]) => [key, value]));
}

export function terraformToTopologyIr(exampleRoot: string, options: { title?: string } = {}): TerraformTopologyIr {
  if (!safeExistsSync(exampleRoot) || !safeStat(exampleRoot).isDirectory()) {
    throw new Error(`Terraform root not found: ${exampleRoot}`);
  }
  const tfFiles = listTfFiles(exampleRoot);
  if (tfFiles.length === 0) {
    throw new Error(`No Terraform files found under: ${exampleRoot}`);
  }

  const rootBlocks = tfFiles.flatMap((filePath) => parseBlocks(filePath, exampleRoot));
  const externalModuleSourceBlocks = collectExternalModuleSourceBlocks(exampleRoot, rootBlocks);
  const allBlocks = [...rootBlocks, ...externalModuleSourceBlocks].filter((block) =>
    ['provider', 'resource', 'data', 'module', 'backend', 'variable', 'output'].includes(block.kind),
  );
  const title = options.title || path.basename(exampleRoot);
  const moduleSourceDirs = collectModuleSourceDirs(exampleRoot, allBlocks);
  const runtimeBlocks = allBlocks
    .filter((block) => !isWithinModuleSourceDir(block.dir, moduleSourceDirs))
    .filter((block) => ['provider', 'resource', 'data', 'module', 'backend'].includes(block.kind));

  return {
    kind: 'terraform_topology_ir',
    version: '1.0.0',
    source_kind: 'terraform',
    source_root: exampleRoot,
    title,
    provider: 'aws',
    tfFiles,
    allBlocks,
    runtimeBlocks,
    moduleSourceDirs,
    callerBlocksBySource: toCallerBlocksBySource(exampleRoot, runtimeBlocks),
  };
}

export function resolveTerraformModuleSourceDir(block: TerraformBlock, exampleRoot: string): string | null {
  return resolveModuleSourceDir(block, exampleRoot);
}
