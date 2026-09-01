import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import type { ScopeContext } from './scope-context.js';
import { resolveKnowledgeScopeSet, assertKnowledgePathInScope } from './knowledge-scope.js';

/**
 * KnowledgeProvider abstracts the access to the `knowledge/` directory.
 * This allows skills to access rules, thresholds, and standards without
 * directly using the `fs` module, making testing significantly easier
 * and reducing environmental dependencies.
 */
export class KnowledgeProvider {
  private static mockData: Record<string, any> = {};
  private static useMock = false;

  /**
   * Enable mock mode for testing.
   */
  static enableMockMode(data: Record<string, any> = {}) {
    this.useMock = true;
    this.mockData = data;
  }

  /**
   * Disable mock mode and clear mock data.
   */
  static disableMockMode() {
    this.useMock = false;
    this.mockData = {};
  }

  /**
   * Load and parse a JSON file from the knowledge directory.
   * @param relativePath Path relative to the `knowledge/` root.
   * @param defaultValue Optional default value if the file is not found.
   */
  static getJson<T = any>(
    relativePath: string,
    defaultValue?: T,
    options: { scope?: ScopeContext; systemAuthority?: boolean } = {}
  ): T {
    this.assertReadable(relativePath, options);
    if (this.useMock) {
      if (this.mockData[relativePath] !== undefined) {
        return this.mockData[relativePath] as T;
      }
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`[Mock] Knowledge file not found: ${relativePath}`);
    }

    const fullPath = pathResolver.knowledge(relativePath);
    this.assertSafeResourcePath(fullPath);
    if (!safeExistsSync(fullPath)) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Knowledge file not found: ${fullPath}`);
    }

    try {
      return readJson<T>(fullPath);
    } catch (err: any) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Failed to parse Knowledge file ${relativePath}: ${err.message}`);
    }
  }

  /**
   * Read raw text content from a knowledge file.
   */
  static getText(
    relativePath: string,
    defaultValue?: string,
    options: { scope?: ScopeContext; systemAuthority?: boolean } = {}
  ): string {
    this.assertReadable(relativePath, options);
    if (this.useMock) {
      if (this.mockData[relativePath] !== undefined) {
        return String(this.mockData[relativePath]);
      }
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`[Mock] Knowledge text file not found: ${relativePath}`);
    }

    const fullPath = pathResolver.knowledge(relativePath);
    this.assertSafeResourcePath(fullPath);
    if (!safeExistsSync(fullPath)) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Knowledge file not found: ${fullPath}`);
    }
    return safeReadFile(fullPath, { encoding: 'utf8' }) as string;
  }

  private static assertReadable(
    relativePath: string,
    options: { scope?: ScopeContext; systemAuthority?: boolean }
  ): void {
    const scope = options.scope || { tier: 'public' as const };
    const scopeSet = resolveKnowledgeScopeSet(scope, {
      systemAuthority: options.systemAuthority === true,
    });
    if (!assertKnowledgePathInScope(relativePath, scopeSet)) {
      throw new Error(
        `[KNOWLEDGE_SCOPE_DENIED] path '${relativePath}' is outside the authorized knowledge scope`
      );
    }
  }

  private static assertSafeResourcePath(fullPath: string): void {
    const root = path.resolve(pathResolver.knowledge());
    const absolute = path.resolve(fullPath);
    const relative = path.relative(root, absolute).replaceAll('\\', '/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error(`[KNOWLEDGE_SCOPE_DENIED] path '${fullPath}' is outside knowledge root`);
    }
    try {
      if (safeLstat(root).isSymbolicLink()) {
        throw new Error('[KNOWLEDGE_SCOPE_DENIED] knowledge root cannot be a symbolic link');
      }
      let current = root;
      for (const segment of relative.split('/')) {
        current = path.join(current, segment);
        try {
          if (safeLstat(current).isSymbolicLink()) {
            throw new Error(
              `[KNOWLEDGE_SCOPE_DENIED] knowledge path cannot traverse a symbolic link: ${relative}`
            );
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('[KNOWLEDGE_SCOPE_DENIED]')) {
            throw error;
          }
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[KNOWLEDGE_SCOPE_DENIED]')) {
        throw error;
      }
      throw new Error(`[KNOWLEDGE_SCOPE_DENIED] knowledge path could not be inspected safely`);
    }
  }
}
