/** PI-12: deterministic source archive, checksum, and clean-install smoke. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeExecResult,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  assertSafeRepositoryPath,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

const DEFAULT_OUTPUT = pathResolver.rootResolve(
  'active/shared/exports/source-archives/kyberion-source.tar.gz'
);
const MAX_ARCHIVE_MB = 256;

export interface SourceArchiveArtifact {
  archivePath: string;
  checksumsPath: string;
  ref: string;
  bytes: number;
  sha256: string;
}

function assertSafeRef(ref: string): string {
  const normalized = ref.trim();
  if (!normalized || !/^[A-Za-z0-9._/-]+$/u.test(normalized) || normalized.includes('..')) {
    throw new Error(`Invalid git archive ref: ${ref}`);
  }
  return normalized;
}

function archiveBytes(ref: string): Buffer {
  const result = safeExecResult(
    'git',
    ['archive', '--format=tar', '--prefix=kyberion/', assertSafeRef(ref)],
    {
      cwd: pathResolver.rootDir(),
      encoding: null,
      timeoutMs: 120_000,
      maxOutputMB: MAX_ARCHIVE_MB,
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `source archive creation failed: ${result.stderr || result.stdout || result.error?.message || 'git archive failed'}`
    );
  }
  if (!Buffer.isBuffer(result.stdout)) {
    throw new Error('source archive command did not return binary output');
  }
  return gzipSync(result.stdout, { level: 9 });
}

function archiveSha256(archive: Buffer): string {
  return createHash('sha256').update(archive).digest('hex');
}

export function checksumLine(archivePath: string, sha256: string): string {
  return `${sha256}  ${path.basename(archivePath)}\n`;
}

export function parseSha256Sums(source: string, archiveName: string): string {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = lines.map((line) => line.match(/^([a-f0-9]{64})  (.+)$/u));
  if (entries.some((entry) => entry === null)) {
    throw new Error('SHA256SUMS contains a malformed entry');
  }
  const matches = entries.filter(
    (match): match is RegExpMatchArray => match !== null && match[2] === archiveName
  );
  if (matches.length !== 1) {
    throw new Error(`SHA256SUMS must contain exactly one entry for ${archiveName}`);
  }
  return matches[0][1];
}

export function resolveSourceArchivePaths(output = DEFAULT_OUTPUT): {
  archivePath: string;
  checksumsPath: string;
} {
  const archivePath = output.endsWith('.tar.gz')
    ? output
    : path.join(output, 'kyberion-source.tar.gz');
  return {
    archivePath,
    checksumsPath: path.join(path.dirname(archivePath), 'SHA256SUMS'),
  };
}

export function resolveSafeSourceArchivePaths(output = DEFAULT_OUTPUT): {
  archivePath: string;
  checksumsPath: string;
} {
  const paths = resolveSourceArchivePaths(output);
  return {
    archivePath: assertSafeRepositoryPath(pathResolver.resolve(paths.archivePath), {
      allowMissingLeaf: true,
    }),
    checksumsPath: assertSafeRepositoryPath(pathResolver.resolve(paths.checksumsPath), {
      allowMissingLeaf: true,
    }),
  };
}

export function createSourceArchive(
  options: {
    ref?: string;
    output?: string;
  } = {}
): SourceArchiveArtifact {
  const ref = assertSafeRef(options.ref || 'HEAD');
  const { archivePath, checksumsPath } = resolveSafeSourceArchivePaths(options.output);
  const archive = archiveBytes(ref);
  const sha256 = archiveSha256(archive);
  safeMkdir(path.dirname(archivePath), { recursive: true });
  safeWriteFile(archivePath, archive);
  safeWriteFile(checksumsPath, checksumLine(archivePath, sha256));
  return { archivePath, checksumsPath, ref, bytes: archive.length, sha256 };
}

export function verifySourceArchive(
  archivePath: string,
  checksumsPath?: string
): SourceArchiveArtifact {
  const safeArchivePath = assertSafeRepositoryPath(pathResolver.resolve(archivePath), {
    allowMissingLeaf: true,
  });
  const resolvedChecksumsPath = assertSafeRepositoryPath(
    pathResolver.resolve(checksumsPath || path.join(path.dirname(archivePath), 'SHA256SUMS')),
    { allowMissingLeaf: true }
  );
  if (!safeExistsSync(safeArchivePath) || !safeExistsSync(resolvedChecksumsPath)) {
    throw new Error(`Source archive or SHA256SUMS is missing for ${safeArchivePath}`);
  }
  const archive = safeReadFile(safeArchivePath, { encoding: null }) as Buffer;
  const expected = parseSha256Sums(
    String(safeReadFile(resolvedChecksumsPath, { encoding: 'utf8' })),
    path.basename(safeArchivePath)
  );
  const actual = archiveSha256(archive);
  if (expected !== actual) {
    throw new Error(`Source archive checksum mismatch for ${safeArchivePath}`);
  }
  return {
    archivePath: safeArchivePath,
    checksumsPath: resolvedChecksumsPath,
    ref: 'verified',
    bytes: archive.length,
    sha256: actual,
  };
}

export function runSourceArchiveInstallSmoke(ref = 'HEAD'): {
  archive: SourceArchiveArtifact;
  install: 'passed';
} {
  const smokeRoot = pathResolver.sharedTmp('source-archive-install-smoke');
  safeRmSync(smokeRoot, { recursive: true, force: true });
  safeMkdir(smokeRoot, { recursive: true });
  try {
    const archive = createSourceArchive({
      ref,
      output: path.join(smokeRoot, 'kyberion-source.tar.gz'),
    });
    const extract = safeExecResult(
      'tar',
      ['-xzf', archive.archivePath, '-C', smokeRoot, '--strip-components=1'],
      { cwd: pathResolver.rootDir(), timeoutMs: 120_000, maxOutputMB: 20 }
    );
    if (extract.status !== 0) {
      throw new Error(
        `source archive extraction failed: ${extract.stderr || extract.stdout || 'tar failed'}`
      );
    }
    const install = safeExecResult('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: smokeRoot,
      timeoutMs: 600_000,
      maxOutputMB: 50,
    });
    if (install.status !== 0) {
      throw new Error(
        `source archive install smoke failed: ${install.stderr || install.stdout || install.error?.message || 'pnpm install failed'}`
      );
    }
    if (!safeExistsSync(path.join(smokeRoot, 'node_modules'))) {
      throw new Error('source archive install smoke produced no node_modules directory');
    }
    return { archive, install: 'passed' };
  } finally {
    safeRmSync(smokeRoot, { recursive: true, force: true });
  }
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export const runSourceArchive = defineScript({
  name: 'release:source-archive',
  flags: ['check'],
  run(context) {
    const output = optionValue(context.argv, '--output');
    const ref = optionValue(context.argv, '--ref') || 'HEAD';
    if (context.argv.includes('--install-smoke')) {
      const result = runSourceArchiveInstallSmoke(ref);
      context.print({ ok: true, mode: 'install-smoke', archive: result.archive });
      return result;
    }
    const paths = resolveSourceArchivePaths(output);
    const result = context.check
      ? verifySourceArchive(paths.archivePath, paths.checksumsPath)
      : createSourceArchive({ ref, output });
    context.print({ ok: true, mode: context.check ? 'verify' : 'create', ...result });
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'source_archive.ts') ||
  isDirectScript(import.meta.url, 'source_archive.js')
)
  void runSourceArchive();
