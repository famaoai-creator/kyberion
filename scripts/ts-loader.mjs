import { readFileSync, existsSync } from 'node:fs';
import { dirname, extname, resolve as resolvePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JS_LIKE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const ROOT_DIR = process.cwd();

function isFileUrl(specifier) {
  return specifier.startsWith('file:');
}

function toFilePath(specifier, parentURL) {
  if (isFileUrl(specifier)) return fileURLToPath(specifier);
  if (specifier.startsWith('/')) return specifier;
  const parentPath = parentURL && isFileUrl(parentURL) ? fileURLToPath(parentURL) : process.cwd();
  return resolvePath(dirname(parentPath), specifier);
}

function resolveCandidatePath(candidate) {
  return existsSync(candidate) ? pathToFileURL(candidate).href : null;
}

function resolveTsLike(specifier, context, nextResolve) {
  if (!(specifier.startsWith('.') || specifier.startsWith('/'))) {
    return nextResolve(specifier, context);
  }

  const parentPath = context.parentURL && isFileUrl(context.parentURL) ? fileURLToPath(context.parentURL) : ROOT_DIR;
  if (!parentPath.startsWith(ROOT_DIR) || parentPath.includes('/node_modules/')) {
    return nextResolve(specifier, context);
  }

  const sourcePath = toFilePath(specifier, context.parentURL);
  const sourceExt = extname(sourcePath);
  const candidates = [];

  if (sourceExt) {
    candidates.push(sourcePath);
  }

  if (JS_LIKE_EXTENSIONS.has(sourceExt) || !sourceExt) {
    const stem = sourceExt ? sourcePath.slice(0, -sourceExt.length) : sourcePath;
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
    candidates.push(
      resolvePath(sourcePath, 'index.ts'),
      resolvePath(sourcePath, 'index.tsx'),
      resolvePath(sourcePath, 'index.mts'),
      resolvePath(sourcePath, 'index.cts'),
    );
  }

  for (const candidate of candidates) {
    const resolved = resolveCandidatePath(candidate);
    if (resolved) {
      return nextResolve(resolved, context);
    }
  }

  return nextResolve(specifier, context);
}

function loadTsLike(url, context, nextLoad) {
  const filePath = isFileUrl(url) ? fileURLToPath(url) : null;
  if (!filePath) {
    return nextLoad(url, context);
  }

  if (!filePath.startsWith(ROOT_DIR) || filePath.includes('/node_modules/')) {
    return nextLoad(url, context);
  }

  const ext = extname(filePath);
  if (!TS_EXTENSIONS.has(ext)) {
    return nextLoad(url, context);
  }

  const loader = ext === '.tsx' ? 'tsx' : 'ts';
  const source = readFileSync(filePath, 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ext === '.cts' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
      jsx: loader === 'tsx' ? ts.JsxEmit.ReactJSX : ts.JsxEmit.Preserve,
      sourceMap: true,
      inlineSourceMap: true,
      inlineSources: true,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
    fileName: filePath,
    reportDiagnostics: false,
  });

  return {
    format: ext === '.cts' ? 'commonjs' : 'module',
    source: result.outputText,
    shortCircuit: true,
  };
}

registerHooks({
  resolve: resolveTsLike,
  load: loadTsLike,
});
