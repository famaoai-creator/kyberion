import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

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
  static getJson<T = any>(relativePath: string, defaultValue?: T): T {
    if (this.useMock) {
      if (this.mockData[relativePath] !== undefined) {
        return this.mockData[relativePath] as T;
      }
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`[Mock] Knowledge file not found: ${relativePath}`);
    }

    const fullPath = pathResolver.knowledge(relativePath);
    if (!safeExistsSync(fullPath)) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Knowledge file not found: ${fullPath}`);
    }

    try {
      const content = safeReadFile(fullPath, { encoding: 'utf8' }) as string;
      return JSON.parse(content) as T;
    } catch (err: any) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Failed to parse Knowledge file ${relativePath}: ${err.message}`);
    }
  }

  /**
   * Read raw text content from a knowledge file.
   */
  static getText(relativePath: string, defaultValue?: string): string {
    if (this.useMock) {
      if (this.mockData[relativePath] !== undefined) {
        return String(this.mockData[relativePath]);
      }
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`[Mock] Knowledge text file not found: ${relativePath}`);
    }

    const fullPath = pathResolver.knowledge(relativePath);
    if (!safeExistsSync(fullPath)) {
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Knowledge file not found: ${fullPath}`);
    }
    return safeReadFile(fullPath, { encoding: 'utf8' }) as string;
  }
}
