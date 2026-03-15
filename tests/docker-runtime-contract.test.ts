import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '../libs/core/index.js';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Docker runtime contract', () => {
  it('keeps Dockerfile aligned with current built-artifact execution', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('FROM node:20-slim AS base');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "dist/scripts/cli.js"]');
    expect(dockerfile).not.toContain('dist/scripts/bootstrap.js');
  });

  it('copies workspace metadata required by runtime surfaces', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml');
    expect(dockerfile).toContain('COPY --from=builder /app/presence ./presence');
    expect(dockerfile).toContain('COPY --from=builder /app/satellites ./satellites');
  });

  it('keeps docker-compose on build-first, built-cli execution', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toContain('pnpm install --frozen-lockfile');
    expect(compose).toContain('pnpm build');
    expect(compose).toContain('node dist/scripts/cli.js list implemented');
    expect(compose).not.toContain('dist/scripts/bootstrap.js');
  });
});
