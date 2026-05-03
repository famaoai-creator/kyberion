import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { safeLstat, safeReadFile, safeReaddir } from "@agent/core/secure-io";

const rootDir = process.cwd();
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
// Build-time tool configs (vitest.config, vite.config, next.config, ...) need
// to point their resolver aliases at libs/core source files. They never run at
// app runtime, so they are exempt from the runtime boundary contract.
const CONFIG_FILE_PATTERN = /\.(config|setup)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "coverage",
  "active",
  "work",
  "vault",
]);
const RUNTIME_ROOTS = ["scripts", "libs/actuators", "presence/displays", "satellites"];
const TEST_ROOTS = ["tests"];
const ALLOWED_TEST_SOURCE_IMPORTS = new Map<string, string[]>([
  [
    'tests/mission-team-orchestrator.test.ts',
    [
      '../libs/core/mission-team-plan-composer.js',
      '../libs/core/agent-registry.js',
      '../libs/core/agent-runtime-supervisor.js',
      '../libs/core/agent-runtime-supervisor-client.js',
    ],
  ],
]);
const ALLOWED_SCRIPT_CANONICAL_ROOT_CWD = new Set<string>([]);
const ALLOWED_PLUGIN_SATELLITE_CANONICAL_ROOT_CWD = new Set<string>([]);

function walk(relDir: string): string[] {
  const absDir = path.join(rootDir, relDir);
  const files: string[] = [];

  for (const entry of safeReaddir(absDir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const relPath = path.join(relDir, entry);
    const absPath = path.join(rootDir, relPath);
    const stat = safeLstat(absPath);

    if (stat.isDirectory()) {
      files.push(...walk(relPath));
      continue;
    }

    if (CODE_EXTENSIONS.has(path.extname(entry)) && !CONFIG_FILE_PATTERN.test(entry)) {
      files.push(relPath);
    }
  }

  return files;
}

function findMatches(pattern: RegExp): string[] {
  const matches: string[] = [];

  for (const relRoot of RUNTIME_ROOTS) {
    for (const relPath of walk(relRoot)) {
      const content = safeReadFile(path.join(rootDir, relPath), { encoding: "utf8" }) as string;
      if (pattern.test(content)) {
        matches.push(relPath);
      }
    }
  }

  return matches.sort((a, b) => a.localeCompare(b));
}

function findMatchesInRoots(roots: string[], pattern: RegExp): string[] {
  const matches: string[] = [];

  for (const relRoot of roots) {
    for (const relPath of walk(relRoot)) {
      if (relPath === "tests/package-boundary-contract.test.ts") continue;
      const content = safeReadFile(path.join(rootDir, relPath), { encoding: "utf8" }) as string;
      if (pattern.test(content)) {
        matches.push(relPath);
      }
    }
  }

  return matches.sort((a, b) => a.localeCompare(b));
}

function collectTestSourceImports(): Array<{ relPath: string; specifier: string }> {
  const matches: Array<{ relPath: string; specifier: string }> = [];

  for (const relRoot of TEST_ROOTS) {
    for (const relPath of walk(relRoot)) {
      if (relPath === "tests/package-boundary-contract.test.ts") continue;
      const content = safeReadFile(path.join(rootDir, relPath), { encoding: "utf8" }) as string;
      for (const match of content.matchAll(/["'](\.\.\/(?:\.\.\/)?(?:\.\.\/)?libs\/core\/[^"']+)["']/g)) {
        matches.push({ relPath, specifier: match[1] });
      }
    }
  }

  return matches.sort((a, b) => `${a.relPath}:${a.specifier}`.localeCompare(`${b.relPath}:${b.specifier}`));
}

function collectCorePackageSpecifiers(roots: string[]): string[] {
  const matches = new Set<string>();

  for (const relRoot of roots) {
    for (const relPath of walk(relRoot)) {
      const content = safeReadFile(path.join(rootDir, relPath), { encoding: "utf8" }) as string;
      for (const match of content.matchAll(/@agent\/core(?:\/([A-Za-z0-9._/-]+))?/g)) {
        if (!match[1]) continue;
        matches.add(`./${match[1]}`);
      }
    }
  }

  return [...matches].sort((a, b) => a.localeCompare(b));
}

function findCanonicalRootAssembly(roots: string[], allowlist: Set<string>): string[] {
  const matches: string[] = [];
  const directAnchorPattern = /path\.(?:join|resolve)\(\s*process\.cwd\(\)\s*,\s*["'](?:active(?:\/|["'])|knowledge(?:\/|["'])|vault(?:\/|["'])|scripts(?:\/|["'])|vision(?:\/|["'])|dist\/scripts\/|work(?:\/|["'])|presence(?:\/|["']))/;
  const rootVarPattern = /const\s+ROOT\s*=\s*process\.cwd\(\)/;
  const canonicalLiteralPattern = /["'](?:active(?:\/|["'])|knowledge(?:\/|["'])|vault(?:\/|["'])|scripts(?:\/|["'])|vision(?:\/|["'])|dist\/scripts\/|work(?:\/|["'])|presence(?:\/|["']))/;

  for (const relRoot of roots) {
    for (const relPath of walk(relRoot)) {
      const content = safeReadFile(path.join(rootDir, relPath), { encoding: "utf8" }) as string;
      if (allowlist.has(relPath)) continue;
      if (directAnchorPattern.test(content)) {
        matches.push(relPath);
        continue;
      }
      if (rootVarPattern.test(content) && canonicalLiteralPattern.test(content)) {
        matches.push(relPath);
      }
    }
  }

  return matches.sort((a, b) => a.localeCompare(b));
}

describe("Package boundary contract", () => {
  it("forbids runtime imports from @agent/core/src and @agent/core/dist", () => {
    const matches = findMatches(/@agent\/core\/(?:src|dist)\//);
    expect(matches).toEqual([]);
  });

  it("forbids runtime imports from libs/core via relative paths", () => {
    const matches = findMatches(/\.\.\/(?:\.\.\/)?(?:\.\.\/)?libs\/core\//);
    expect(matches).toEqual([]);
  });

  it("forbids test imports from @agent/core/src and @agent/core/dist", () => {
    const matches = findMatchesInRoots(TEST_ROOTS, /@agent\/core\/(?:src|dist)\//);
    expect(matches).toEqual([]);
  });

  it("forbids test imports from libs/core/dist via relative paths", () => {
    const matches = findMatchesInRoots(TEST_ROOTS, /\.\.\/(?:\.\.\/)?(?:\.\.\/)?libs\/core\/dist\//);
    expect(matches).toEqual([]);
  });

  it("forbids .js suffixes in @agent/core package subpath imports", () => {
    const matches = findMatchesInRoots([...RUNTIME_ROOTS, ...TEST_ROOTS], /@agent\/core\/[A-Za-z0-9._/-]+\.js\b/);
    expect(matches).toEqual([]);
  });

  it("allows only explicit white-box test imports from libs/core source modules", () => {
    const matches = collectTestSourceImports();
    const unexpected = matches.filter(({ relPath, specifier }) => {
      const allowed = ALLOWED_TEST_SOURCE_IMPORTS.get(relPath) ?? [];
      return !allowed.includes(specifier);
    });
    expect(unexpected).toEqual([]);
  });

  it("requires @agent/core package exports to be explicit and cover all used subpaths", () => {
    const packageJson = JSON.parse(
      safeReadFile(path.join(rootDir, "libs/core/package.json"), { encoding: "utf8" }) as string,
    ) as { exports: Record<string, unknown> };
    const exportKeys = Object.keys(packageJson.exports);
    expect(exportKeys).not.toContain("./*");
    expect(exportKeys).not.toContain("./*.js");

    const usedSpecifiers = collectCorePackageSpecifiers([...RUNTIME_ROOTS, ...TEST_ROOTS]);
    const missing = usedSpecifiers
      .filter((specifier) => specifier !== "./src" && specifier !== "./dist")
      .filter((specifier) => !exportKeys.includes(specifier));
    expect(missing).toEqual([]);
  });

  it("forbids scripts from anchoring canonical repo roots with process.cwd()", () => {
    const matches = findCanonicalRootAssembly(["scripts"], ALLOWED_SCRIPT_CANONICAL_ROOT_CWD);
    expect(matches).toEqual([]);
  });

  it("forbids plugins/satellites from anchoring canonical repo roots with process.cwd()", () => {
    const matches = findCanonicalRootAssembly(["plugins", "satellites"], ALLOWED_PLUGIN_SATELLITE_CANONICAL_ROOT_CWD);
    expect(matches).toEqual([]);
  });
});
