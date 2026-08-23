import * as path from 'node:path';
import { createHash } from 'node:crypto';
import AjvModule, { type Ajv as AjvInstance } from 'ajv';

import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';

const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.swift',
  '.ts',
  '.tsx',
]);

const CONFIG_EXTENSIONS = new Set(['.json', '.toml', '.ini', '.properties', '.xml']);
const IAC_EXTENSIONS = new Set(['.tf', '.tfvars', '.hcl']);
const YAML_NAMES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'Chart.yaml']);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.agy',
  '.claude',
  '.codex',
  '.copilot',
  '.gemini',
  '.terraform',
  '.terragrunt-cache',
  'active',
  'coverage',
  'dist',
  'knowledge',
  'node_modules',
  'target',
  'vault',
  'vendor',
]);

const SKIPPED_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.test',
  'credential.kyberion-connections',
  'credential.kyberion-vault',
]);

export interface SourceAnalysisFile {
  path: string;
  kind: 'source' | 'test' | 'iac' | 'config' | 'documentation' | 'other';
  language?: string;
  bytes: number;
  lines: number;
  sha256: string;
  imports: string[];
  exports: string[];
  routes: string[];
  test_names: string[];
  iac_kinds: string[];
}

export interface SourceAnalysisTest {
  id: string;
  title: string;
  path: string;
  framework: string;
  test_names: string[];
  assertion_count: number;
  behavior_categories: string[];
  side_effect_signals: string[];
  execution_mode: 'safe_auto' | 'approval_required' | 'manual_only';
  reason: string;
}

export interface SourceAnalysisIr {
  kind: 'source-analysis-ir';
  version: '1.0.0';
  source_root: string;
  file_count: number;
  source_file_count: number;
  test_file_count: number;
  iac_file_count: number;
  scan: {
    max_files: number;
    files_observed: number;
    truncated: boolean;
  };
  languages: Record<string, number>;
  dependencies: string[];
  routes: Array<{ method: string; path: string; source: string }>;
  files: SourceAnalysisFile[];
  tests: SourceAnalysisTest[];
  iac: Array<{ path: string; kind: string; blocks: string[] }>;
  evidence: string[];
  limitations: string[];
}

export interface EngineeringArtifactBundle {
  analysis_ir: SourceAnalysisIr;
  design_document: string;
  test_inventory: Record<string, unknown>;
  test_scenario_pipeline: Record<string, unknown>;
  iac_proposal: {
    kind: 'iac-proposal';
    version: '1.0.0';
    status: 'proposal-only' | 'blocked-no-target-provider';
    source_refs: string[];
    target_provider: string | null;
    candidate_resources: string[];
    validation_commands: string[];
    terraform: string;
  };
}

export interface AnalyzeSourceTreeOptions {
  sourceRoot?: string;
  maxFiles?: number;
}

const SOURCE_ANALYSIS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/source-analysis-ir.schema.json'
);
const SOURCE_TEST_SCENARIO_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/source-test-scenarios.schema.json'
);
const SOURCE_IAC_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/source-iac-proposal.schema.json'
);
const TEST_INVENTORY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/test-inventory.schema.json'
);
const ArtifactAjvCtor = AjvModule as unknown as new (options: {
  allErrors: boolean;
}) => AjvInstance;
const artifactAjv = new ArtifactAjvCtor({ allErrors: true });
const validateSourceAnalysisSchema = compileSchemaFromPath(
  artifactAjv,
  SOURCE_ANALYSIS_SCHEMA_PATH
);
const validateTestInventorySchema = compileSchemaFromPath(artifactAjv, TEST_INVENTORY_SCHEMA_PATH);
const validateTestScenarioSchema = compileSchemaFromPath(
  artifactAjv,
  SOURCE_TEST_SCENARIO_SCHEMA_PATH
);
const validateIacSchema = compileSchemaFromPath(artifactAjv, SOURCE_IAC_SCHEMA_PATH);

function languageFor(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  const languages: Record<string, string> = {
    '.c': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.go': 'go',
    '.java': 'java',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.mjs': 'javascript',
    '.php': 'php',
    '.py': 'python',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.swift': 'swift',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.tf': 'terraform',
    '.tfvars': 'terraform',
    '.hcl': 'hcl',
  };
  return languages[extension];
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.replaceAll(path.sep, '/');
  return (
    /(^|\/)(__tests__|tests?|spec)\//u.test(normalized) ||
    /\.(test|spec)\.[^.]+$/u.test(normalized) ||
    /(^|\/)test_[^/]+\.py$/u.test(normalized)
  );
}

function classifyFile(filePath: string): SourceAnalysisFile['kind'] {
  const baseName = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase();
  if (isTestPath(filePath)) return 'test';
  if (IAC_EXTENSIONS.has(extension) || YAML_NAMES.has(baseName)) return 'iac';
  if (SOURCE_EXTENSIONS.has(extension)) return 'source';
  if (CONFIG_EXTENSIONS.has(extension) || /^(Dockerfile|Makefile|Jenkinsfile)$/u.test(baseName)) {
    return 'config';
  }
  if (extension === '.md' || extension === '.adoc' || extension === '.rst') return 'documentation';
  return 'other';
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function matches(text: string, expression: RegExp): string[] {
  return [...text.matchAll(expression)]
    .map((match) => String(match[1] ?? match[0] ?? ''))
    .filter(Boolean);
}

function extractImports(text: string): string[] {
  return unique([
    ...matches(text, /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu),
    ...matches(text, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ...matches(text, /^\s*(?:from\s+([^\s]+)\s+import|import\s+([^\s#]+))/gmu).flatMap((value) =>
      value.split(',')
    ),
    ...matches(text, /^\s*use\s+([^;]+);/gmu),
  ]);
}

function extractExports(text: string): string[] {
  return unique([
    ...matches(
      text,
      /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu
    ),
    ...matches(text, /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gmu),
    ...matches(text, /^\s*class\s+([A-Za-z_]\w*)/gmu),
  ]);
}

function extractRoutes(text: string): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  const routePattern =
    /\b(?:app|router|server)\.(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/giu;
  for (const match of text.matchAll(routePattern)) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  const decoratorPattern = /@(Get|Post|Put|Patch|Delete|Head)\s*\(\s*['"]?([^'"\)\s]*)/gu;
  for (const match of text.matchAll(decoratorPattern)) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] || '/' });
  }
  return routes;
}

function extractTestNames(text: string): string[] {
  return unique([
    ...matches(text, /\b(?:describe|context|it|test)\s*\(\s*['"]([^'"]+)['"]/gu),
    ...matches(text, /\b(?:def\s+test_[A-Za-z_]\w*|class\s+Test[A-Za-z_]\w*)/gmu),
  ]);
}

function detectIacKinds(text: string, filePath: string): string[] {
  const kinds = new Set<string>();
  const extension = path.extname(filePath).toLowerCase();
  if (IAC_EXTENSIONS.has(extension)) {
    for (const match of text.matchAll(
      /\b(resource|module|provider|data|variable|output|terraform)\s+"([^"]+)"/gu
    )) {
      kinds.add(`${match[1]}:${match[2]}`);
    }
  }
  if (extension === '.yaml' || extension === '.yml') {
    for (const match of text.matchAll(/^\s*kind:\s*([A-Za-z0-9_.-]+)/gmu))
      kinds.add(`kubernetes:${match[1]}`);
  }
  if (path.basename(filePath).startsWith('docker-compose.')) kinds.add('compose:services');
  if (path.basename(filePath) === 'Chart.yaml') kinds.add('helm:chart');
  return [...kinds].sort();
}

function frameworkFor(filePath: string, text: string): string {
  if (/vitest|from\s+['"]vitest['"]/u.test(text)) return 'vitest';
  if (/jest|from\s+['"]@jest/u.test(text)) return 'jest';
  if (/playwright/u.test(text)) return 'playwright';
  if (/pytest|unittest/u.test(text)) return 'pytest';
  if (/go\s+test/u.test(text) || filePath.endsWith('_test.go')) return 'go-test';
  return 'unknown';
}

const SIDE_EFFECT_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'network-request', pattern: /\b(?:fetch|axios|got|superagent)\s*\(/u },
  { name: 'http-request', pattern: /\b(?:http|https)\.request\s*\(/u },
  { name: 'process-execution', pattern: /\b(?:child_process|exec|spawn|execa)\b/u },
  { name: 'destructive-command', pattern: /\b(?:docker|kubectl|terraform|git)\s+/u },
  { name: 'process-exit', pattern: /\bprocess\.exit\s*\(/u },
  {
    name: 'filesystem-mutation',
    pattern:
      /\b(?:fs\.(?:writeFile|rm|unlink|mkdir)(?:Sync)?|safe(?:Mkdir|WriteFile|RmSync|UnlinkSync))\b/u,
  },
];

function countAssertions(text: string, framework: string): number {
  const patterns =
    framework === 'pytest'
      ? [/\bassert\b/gu, /\bpytest\.raises\s*\(/gu, /\bself\.assert[A-Z]\w*\s*\(/gu]
      : framework === 'go-test'
        ? [/\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow|Log|Logf)\s*\(/gu]
        : [/\bexpect\s*\(/gu, /\bassert(?:\.[A-Za-z]+)?\s*\(/gu];
  return patterns.reduce((count, pattern) => count + [...text.matchAll(pattern)].length, 0);
}

function detectBehaviorCategories(text: string, testNames: string[]): string[] {
  const signalText = `${testNames.join(' ')}\n${text}`.toLowerCase();
  const categories = new Set<string>();
  const rules: Array<[string, RegExp]> = [
    ['error-path', /error|fail|invalid|exception|reject|denied|throw/u],
    ['boundary', /boundary|empty|null|undefined|zero|max|min|limit|overflow/u],
    ['security', /auth|permission|tenant|scope|secret|pii|redact|signature/u],
    ['persistence', /file|write|read|store|cache|ledger|database|persist/u],
    ['integration', /integration|adapter|bridge|provider|network|http|api/u],
    ['performance', /timeout|retry|latency|budget|performance|catchup/u],
    ['schema-contract', /schema|contract|manifest|validate|validation/u],
    ['rendering', /render|pdf|pptx|docx|xlsx|theme|layout/u],
    ['happy-path', /success|works|returns|accepts|builds|creates|supports/u],
  ];
  for (const [category, pattern] of rules) if (pattern.test(signalText)) categories.add(category);
  if (categories.size === 0) categories.add('general');
  return [...categories].sort();
}

function detectSideEffectSignals(text: string): string[] {
  return SIDE_EFFECT_RULES.filter(({ pattern }) => pattern.test(text))
    .map(({ name }) => name)
    .sort();
}

function classifyTestExecution(
  framework: string,
  sideEffectSignals: string[]
): { execution_mode: SourceAnalysisTest['execution_mode']; reason: string } {
  if (!['vitest', 'jest', 'pytest', 'go-test'].includes(framework)) {
    return {
      execution_mode: 'manual_only',
      reason: 'No supported deterministic test framework was inferred from the file.',
    };
  }
  if (sideEffectSignals.length > 0) {
    return {
      execution_mode: 'approval_required',
      reason: `Static side-effect signals require human approval: ${sideEffectSignals.join(', ')}.`,
    };
  }
  return {
    execution_mode: 'safe_auto',
    reason: 'Supported test framework detected and no known external or mutating signal was found.',
  };
}

function inferTestLevel(filePath: string, framework: string): string {
  const normalized = filePath.toLowerCase();
  if (framework === 'playwright' || normalized.includes('/e2e/')) return 'e2e';
  if (normalized.includes('integration')) return 'integration';
  if (normalized.includes('component')) return 'component';
  return 'unit';
}

function listFiles(root: string, maxFiles: number): { files: string[]; truncated: boolean } {
  const result: string[] = [];
  let truncated = false;
  const visit = (directory: string): void => {
    for (const entry of safeReaddir(directory).sort()) {
      if (result.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (SKIPPED_DIRECTORIES.has(entry) || SKIPPED_FILE_NAMES.has(entry)) continue;
      const absolute = path.join(directory, entry);
      const stat = safeLstat(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) result.push(absolute);
    }
  };
  visit(root);
  return { files: result, truncated };
}

function assertWorkspacePath(sourceRoot: string): { absolute: string; relative: string } {
  const workspace = pathResolver.rootDir();
  const absolute = path.resolve(workspace, sourceRoot || '.');
  const relative = path.relative(workspace, absolute).replaceAll(path.sep, '/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`source_root must stay within the workspace: ${sourceRoot}`);
  }
  if (!safeExistsSync(absolute) || !safeLstat(absolute).isDirectory()) {
    throw new Error(`source_root directory not found: ${sourceRoot}`);
  }
  return { absolute, relative: relative || '.' };
}

export function analyzeSourceTree(options: AnalyzeSourceTreeOptions = {}): SourceAnalysisIr {
  const resolved = assertWorkspacePath(options.sourceRoot || '.');
  const maxFiles = Math.max(1, Math.min(10000, Number(options.maxFiles || 2000)));
  const files: SourceAnalysisFile[] = [];
  const dependencies = new Set<string>();
  const routes: SourceAnalysisIr['routes'] = [];
  const tests: SourceAnalysisTest[] = [];
  const iac: SourceAnalysisIr['iac'] = [];
  const languages: Record<string, number> = {};

  const listed = listFiles(resolved.absolute, maxFiles);
  for (const absolute of listed.files) {
    const relative = path.relative(resolved.absolute, absolute).replaceAll(path.sep, '/');
    const kind = classifyFile(relative);
    let text = '';
    try {
      text = String(safeReadFile(absolute, { encoding: 'utf8', maxSizeMB: 4 }));
    } catch {
      continue;
    }
    const language = languageFor(relative);
    const imports = extractImports(text);
    const exports = extractExports(text);
    const fileRoutes = extractRoutes(text);
    const testNames = extractTestNames(text);
    const iacKinds = detectIacKinds(text, relative);
    const sha256 = createHash('sha256').update(text).digest('hex');
    const record: SourceAnalysisFile = {
      path: relative,
      kind,
      ...(language ? { language } : {}),
      bytes: Buffer.byteLength(text),
      lines: text.split(/\r?\n/u).length,
      sha256,
      imports,
      exports,
      routes: fileRoutes.map((route) => `${route.method} ${route.path}`).sort(),
      test_names: testNames,
      iac_kinds: iacKinds,
    };
    files.push(record);
    if (language) languages[language] = (languages[language] || 0) + 1;
    imports.forEach((dependency) => dependencies.add(dependency));
    fileRoutes.forEach((route) => routes.push({ ...route, source: relative }));
    if (kind === 'test') {
      const framework = frameworkFor(relative, text);
      const sideEffectSignals = detectSideEffectSignals(text);
      const execution = classifyTestExecution(framework, sideEffectSignals);
      tests.push({
        id: `SRC-TEST-${String(tests.length + 1).padStart(3, '0')}`,
        title: testNames[0] || path.basename(relative),
        path: relative,
        framework,
        test_names: testNames,
        assertion_count: countAssertions(text, framework),
        behavior_categories: detectBehaviorCategories(text, testNames),
        side_effect_signals: sideEffectSignals,
        execution_mode: execution.execution_mode,
        reason: execution.reason,
      });
    }
    if (kind === 'iac' || iacKinds.length > 0) {
      iac.push({
        path: relative,
        kind: language || path.extname(relative).slice(1) || 'config',
        blocks: iacKinds,
      });
    }
  }

  const packagePath = path.join(resolved.absolute, 'package.json');
  if (safeExistsSync(packagePath)) {
    try {
      const packageJson = JSON.parse(
        String(safeReadFile(packagePath, { encoding: 'utf8' }))
      ) as Record<string, unknown>;
      for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const values = packageJson[group];
        if (values && typeof values === 'object')
          Object.keys(values).forEach((name) => dependencies.add(name));
      }
    } catch {
      // The file is still represented in the IR; malformed metadata is a source limitation.
    }
  }

  const sortedFiles = files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    kind: 'source-analysis-ir',
    version: '1.0.0',
    source_root: resolved.relative,
    file_count: sortedFiles.length,
    source_file_count: sortedFiles.filter((file) => file.kind === 'source').length,
    test_file_count: sortedFiles.filter((file) => file.kind === 'test').length,
    iac_file_count: iac.length,
    scan: {
      max_files: maxFiles,
      files_observed: sortedFiles.length,
      truncated: listed.truncated,
    },
    languages: Object.fromEntries(Object.entries(languages).sort(([a], [b]) => a.localeCompare(b))),
    dependencies: [...dependencies].sort(),
    routes: routes.sort((a, b) =>
      `${a.method} ${a.path} ${a.source}`.localeCompare(`${b.method} ${b.path} ${b.source}`)
    ),
    files: sortedFiles,
    tests,
    iac: iac.sort((a, b) => a.path.localeCompare(b.path)),
    evidence: sortedFiles.map((file) => `${resolved.relative}/${file.path}`.replace(/^\.\//u, '')),
    limitations: [
      'Static heuristic extraction; no compiler-level AST or runtime call graph is inferred.',
      'Assertion counts and behavior categories are lexical signals, not proof of semantic coverage.',
      'Tests with detected external or mutating signals require approval before automation.',
      'Generated IaC is a proposal and must pass provider validation and human approval before apply.',
      'Routes without selectors, fixtures, or environment contracts are not executable browser tests.',
    ],
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function markdownCell(values: string[], limit = 6): string {
  if (values.length === 0) return '-';
  const visible = values.slice(0, limit).map((value) => value.replaceAll('|', '\\|'));
  return `${visible.join(', ')}${values.length > limit ? ` (+${values.length - limit} more)` : ''}`;
}

function renderDesignDocument(ir: SourceAnalysisIr): string {
  const languageRows = Object.entries(ir.languages)
    .map(([language, count]) => `| ${language} | ${count} |`)
    .join('\n');
  const routeRows = ir.routes.length
    ? ir.routes.map((route) => `| ${route.method} | ${route.path} | ${route.source} |`).join('\n')
    : '| - | - | No statically detected routes |';
  const iacRows = ir.iac.length
    ? ir.iac
        .map((item) => `| ${item.path} | ${item.kind} | ${item.blocks.join(', ') || '-'} |`)
        .join('\n')
    : '| - | - | No IaC files detected |';
  const moduleRows = ir.files
    .filter((file) => file.kind === 'source' || file.kind === 'test')
    .map(
      (file) =>
        `| ${file.path} | ${markdownCell(file.imports)} | ${markdownCell(file.exports)} | ${markdownCell(file.routes)} |`
    )
    .join('\n');
  const dependencyRows = ir.dependencies.length
    ? ir.dependencies.slice(0, 100).map((dependency) => `- \`${dependency}\``)
    : ['- No dependency/import signals detected.'];
  return [
    '# Source-derived Engineering Design',
    '',
    '> Generated from `source-analysis-ir.json`. This is an evidence-backed draft; review open assumptions before implementation or deployment.',
    '',
    '## 1. Scope',
    '',
    `- Source root: \`${ir.source_root}\``,
    `- Files analyzed: ${ir.file_count} (source ${ir.source_file_count}, tests ${ir.test_file_count}, IaC ${ir.iac_file_count})`,
    `- Scan coverage: ${ir.scan.files_observed}/${ir.scan.max_files} file budget${ir.scan.truncated ? ' (truncated; follow-up required)' : ''}`,
    '- Analysis mode: deterministic static heuristics',
    '',
    '## 2. Language Inventory',
    '',
    '| Language | Files |',
    '| --- | ---: |',
    languageRows || '| - | 0 |',
    '',
    '## 3. Module and Dependency Signals',
    '',
    `- Dependency/import signals: ${ir.dependencies.length}`,
    ...dependencyRows,
    '',
    '| Module | Imports | Exports | Routes |',
    '| --- | --- | --- | --- |',
    moduleRows || '| - | - | - | - |',
    '',
    '## 4. Detected Interfaces',
    '',
    '| Method | Path | Evidence |',
    '| --- | --- | --- |',
    routeRows,
    '',
    '## 5. Infrastructure and Deployment Evidence',
    '',
    '| Path | Kind | Detected blocks |',
    '| --- | --- | --- |',
    iacRows,
    '',
    '## 6. Test Surface',
    '',
    ...(ir.tests.length
      ? ir.tests
      : [
          {
            id: '-',
            title: 'No test files detected',
            path: '-',
            framework: '-',
            assertion_count: 0,
            behavior_categories: ['general'],
            execution_mode: 'manual_only',
            reason: '-',
          },
        ]
    ).map(
      (test) =>
        `- ${test.id}: ${test.title} — \`${test.path}\` (${test.framework}, ${test.execution_mode}; assertions ${test.assertion_count}; behavior ${test.behavior_categories.join(', ')}${test.side_effect_signals.length ? `; signals ${test.side_effect_signals.join(', ')}` : ''})`
    ),
    '',
    '## 7. Evidence and Limitations',
    '',
    ...ir.limitations.map((limitation) => `- ${limitation}`),
    '',
    'Evidence refs:',
    ...ir.evidence.slice(0, 200).map((ref) => `- \`${ref}\``),
    '',
  ].join('\n');
}

function buildTestInventory(ir: SourceAnalysisIr, projectId: string): Record<string, unknown> {
  const items: Array<Record<string, unknown>> = [];
  for (const test of ir.tests) {
    const evidencePath = path.join(ir.source_root, test.path).replaceAll(path.sep, '/');
    const viewpoints = [
      'source.test-presence',
      ...test.behavior_categories.map((category) => `source.behavior.${category}`),
    ];
    const automation = {
      actuator: 'code',
      op: 'run_tests',
      params: { test_path: evidencePath, framework: test.framework },
    };
    items.push({
      item_id: test.id,
      title: test.title,
      viewpoint_ids: viewpoints,
      risk_level: test.side_effect_signals.length > 0 ? 'high' : 'medium',
      preconditions: [
        'Repository dependencies are installed.',
        `Detected test framework is available: ${test.framework}.`,
        ...(test.execution_mode === 'approval_required'
          ? [`Human approval covers: ${test.side_effect_signals.join(', ')}.`]
          : []),
      ],
      steps: [
        `Arrange: use the repository fixtures and inputs defined by ${evidencePath}.`,
        `Act: execute the ${test.framework} test file through code:run_tests.`,
        `Assert: verify ${test.assertion_count} statically detected assertion expression(s).`,
      ],
      expected_result: `The ${test.test_names.length || 1} detected test case(s) in ${evidencePath} complete successfully; ${test.assertion_count} assertion expression(s) were statically detected.`,
      test_level: inferTestLevel(test.path, test.framework),
      execution_mode: test.execution_mode,
      ...(test.execution_mode !== 'manual_only' ? { automation } : {}),
      ...(test.execution_mode !== 'safe_auto' ? { omission_reason: test.reason } : {}),
      requirement_refs: [`source:${evidencePath}`],
      ...(test.side_effect_signals.length > 0
        ? { risk_refs: test.side_effect_signals.map((signal) => `signal:${signal}`) }
        : {}),
    });
  }
  ir.routes.forEach((route, routeIndex) => {
    const evidencePath = path.join(ir.source_root, route.source).replaceAll(path.sep, '/');
    items.push({
      item_id: routeTestId(routeIndex, ir.tests.length),
      title: `${route.method} ${route.path} route contract`,
      viewpoint_ids: ['source.route-contract'],
      risk_level: 'high',
      expected_result: `Route contract is documented and verified for ${route.method} ${route.path}.`,
      test_level: 'contract',
      execution_mode: 'manual_only',
      omission_reason:
        'No environment, authentication fixture, or request contract was inferred safely.',
      preconditions: [
        'Human review must supply environment, authentication, fixture, and request contract.',
      ],
      steps: [
        `Arrange: provide an approved environment and authentication fixture for ${route.method} ${route.path}.`,
        `Act: send the ${route.method} request to ${route.path}.`,
        'Assert: verify the documented status, headers, and response contract.',
      ],
      requirement_refs: [`source:${evidencePath}`],
    });
  });
  return { version: '1.0.0', project_id: projectId, items };
}

function routeTestId(routeIndex: number, testCount: number): string {
  return `SRC-ROUTE-${String(testCount + routeIndex + 1).padStart(3, '0')}`;
}

function buildTestScenarioPipeline(
  ir: SourceAnalysisIr,
  projectId: string
): Record<string, unknown> {
  const steps = ir.tests
    .filter((test) => test.execution_mode === 'safe_auto')
    .map((test) => ({
      id: `run_${test.id.toLowerCase()}`,
      role: 'source',
      op: 'code:run_tests',
      produces: { channel: test.id.toLowerCase(), type: 'TestExecutionResult' },
      params: {
        test_path: path.join(ir.source_root, test.path).replaceAll(path.sep, '/'),
        framework: test.framework,
        export_as: test.id.toLowerCase(),
      },
    }));
  return {
    action: 'pipeline',
    pipeline_id: `source-test-scenarios-${projectId}`,
    version: '1.0.0',
    description:
      'Generated safe_auto test scenario pipeline. It executes existing repository test files only; inferred routes remain manual.',
    context: {
      project_id: projectId,
      source_root: ir.source_root,
      deferred: ir.tests
        .filter((test) => test.execution_mode !== 'safe_auto')
        .map((test) => ({ id: test.id, reason: test.reason, mode: test.execution_mode }))
        .concat(
          ir.routes.map((route, routeIndex) => ({
            id: routeTestId(routeIndex, ir.tests.length),
            reason: `Route ${route.method} ${route.path} requires environment, authentication, fixture, and request-contract review.`,
            mode: 'manual_only',
          }))
        ),
    },
    steps,
  };
}

function buildIacProposal(
  ir: SourceAnalysisIr,
  targetProvider?: string
): EngineeringArtifactBundle['iac_proposal'] {
  const provider = targetProvider?.trim().toLowerCase() || null;
  const candidateResources = unique([
    ...ir.iac.flatMap((item) => item.blocks),
    ...(ir.routes.length ? ['application_endpoint'] : []),
  ]);
  const terraform = provider
    ? renderTerraformProposal(provider, candidateResources)
    : '# No target_provider was supplied. No executable IaC was generated.\n';
  return {
    kind: 'iac-proposal',
    version: '1.0.0',
    status: provider ? 'proposal-only' : 'blocked-no-target-provider',
    source_refs: ir.iac.map((item) => `${ir.source_root}/${item.path}`),
    target_provider: provider,
    candidate_resources: candidateResources,
    validation_commands: provider
      ? ['terraform fmt -check', 'terraform validate', 'terraform plan']
      : [],
    terraform,
  };
}

function schemaFailure(name: string, errors: unknown): Error {
  return new Error(`[SOURCE_ARTIFACT_SCHEMA] ${name} is invalid: ${JSON.stringify(errors)}`);
}

export function validateEngineeringArtifacts(bundle: EngineeringArtifactBundle): void {
  if (!validateSourceAnalysisSchema(bundle.analysis_ir)) {
    throw schemaFailure('source-analysis-ir', validateSourceAnalysisSchema.errors);
  }
  if (!validateTestInventorySchema(bundle.test_inventory)) {
    throw schemaFailure('source-test-inventory', validateTestInventorySchema.errors);
  }
  if (!validateTestScenarioSchema(bundle.test_scenario_pipeline)) {
    throw schemaFailure('source-test-scenarios', validateTestScenarioSchema.errors);
  }
  if (!validateIacSchema(bundle.iac_proposal)) {
    throw schemaFailure('iac-proposal', validateIacSchema.errors);
  }
  const summary = `Files analyzed: ${bundle.analysis_ir.file_count} (source ${bundle.analysis_ir.source_file_count}, tests ${bundle.analysis_ir.test_file_count}, IaC ${bundle.analysis_ir.iac_file_count})`;
  if (
    !bundle.design_document.includes('# Source-derived Engineering Design') ||
    !bundle.design_document.includes(summary) ||
    !bundle.design_document.includes('## 3. Module and Dependency Signals')
  ) {
    throw new Error('[SOURCE_ARTIFACT_SCHEMA] source-derived-design is missing required sections.');
  }
  const sourcePaths = new Set(
    bundle.analysis_ir.files.map((file) =>
      `${bundle.analysis_ir.source_root}/${file.path}`.replace(/^\.\//u, '')
    )
  );
  if (
    bundle.analysis_ir.file_count !== bundle.analysis_ir.files.length ||
    bundle.analysis_ir.test_file_count !==
      bundle.analysis_ir.files.filter((file) => file.kind === 'test').length ||
    bundle.analysis_ir.iac_file_count !== bundle.analysis_ir.iac.length
  ) {
    throw new Error('[SOURCE_ARTIFACT_SCHEMA] source-analysis counts do not match records.');
  }
  const inventory = bundle.test_inventory as {
    items?: Array<{
      item_id?: string;
      requirement_refs?: string[];
      execution_mode?: string;
      automation?: { params?: { test_path?: string; framework?: string } };
    }>;
  };
  for (const item of inventory.items ?? []) {
    for (const ref of item.requirement_refs ?? []) {
      if (ref.startsWith('source:') && !sourcePaths.has(ref.slice('source:'.length))) {
        throw new Error(`[SOURCE_ARTIFACT_SCHEMA] unknown source evidence ref: ${ref}`);
      }
    }
  }
  const scenario = bundle.test_scenario_pipeline as {
    steps?: Array<{ id?: string; params?: { test_path?: string; framework?: string } }>;
  };
  const safeTests = bundle.analysis_ir.tests.filter((test) => test.execution_mode === 'safe_auto');
  if ((scenario.steps?.length ?? 0) !== safeTests.length) {
    throw new Error(
      '[SOURCE_ARTIFACT_SCHEMA] safe_auto tests and scenario steps are inconsistent.'
    );
  }
  for (const test of safeTests) {
    const item = inventory.items?.find((candidate) => candidate.item_id === test.id);
    const step = scenario.steps?.find(
      (candidate) => candidate.id === `run_${test.id.toLowerCase()}`
    );
    const expectedPath = path
      .join(bundle.analysis_ir.source_root, test.path)
      .replaceAll(path.sep, '/');
    if (
      item?.execution_mode !== 'safe_auto' ||
      item.automation?.params?.test_path !== expectedPath ||
      step?.params?.test_path !== expectedPath ||
      step?.params?.framework !== test.framework
    ) {
      throw new Error(
        `[SOURCE_ARTIFACT_SCHEMA] test scenario mapping is inconsistent for ${test.id}.`
      );
    }
  }
}

function renderTerraformProposal(provider: string, candidateResources: string[]): string {
  const providerBlocks: Record<string, string[]> = {
    aws: ['    aws = {', '      source  = "hashicorp/aws"', '      version = "~> 5.0"', '    }'],
    azurerm: [
      '    azurerm = {',
      '      source  = "hashicorp/azurerm"',
      '      version = "~> 4.0"',
      '    }',
    ],
    google: [
      '    google = {',
      '      source  = "hashicorp/google"',
      '      version = "~> 6.0"',
      '    }',
    ],
    kubernetes: [
      '    kubernetes = {',
      '      source  = "hashicorp/kubernetes"',
      '      version = "~> 2.0"',
      '    }',
    ],
  };
  const lines = [
    'terraform {',
    '  required_version = ">= 1.6.0"',
    ...(providerBlocks[provider]
      ? ['  required_providers {', ...providerBlocks[provider], '  }']
      : [
          `  # Provider ${provider} is not in the built-in registry mapping; add its reviewed source and version.`,
        ]),
    '}',
    '',
    `# Target provider: ${provider}`,
    '# Generated as a proposal only. Review every value before init, plan, or apply.',
  ];

  if (provider === 'aws') {
    lines.push(
      '',
      'variable "aws_region" {',
      '  type        = string',
      '  description = "AWS region selected during review."',
      '}',
      '',
      'provider "aws" {',
      '  region = var.aws_region',
      '}'
    );
  } else if (provider === 'azurerm') {
    lines.push('', 'provider "azurerm" {', '  features {}', '}');
  } else if (provider === 'google') {
    lines.push(
      '',
      'variable "gcp_project" {',
      '  type        = string',
      '  description = "GCP project selected during review."',
      '}',
      '',
      'variable "gcp_region" {',
      '  type        = string',
      '  description = "GCP region selected during review."',
      '}',
      '',
      'provider "google" {',
      '  project = var.gcp_project',
      '  region  = var.gcp_region',
      '}'
    );
  } else if (provider === 'kubernetes') {
    lines.push('', 'provider "kubernetes" {}');
  }

  const resourceTypes = unique(
    candidateResources
      .filter((resource) => resource.startsWith('resource:'))
      .map((resource) => resource.slice('resource:'.length))
  );
  if (provider === 'aws' && resourceTypes.includes('aws_s3_bucket')) {
    lines.push(
      '',
      '# Starter generated from the detected resource signal; review naming, encryption, and policy.',
      'variable "source_detected_bucket_name" {',
      '  type        = string',
      '  description = "Globally unique bucket name selected during review."',
      '}',
      '',
      'resource "aws_s3_bucket" "source_detected" {',
      '  bucket = var.source_detected_bucket_name',
      '}'
    );
  }

  lines.push('', '# Candidate signals:');
  lines.push(...candidateResources.map((resource) => `# - ${resource}`));
  if (resourceTypes.some((resource) => resource !== 'aws_s3_bucket' || provider !== 'aws')) {
    lines.push('# Additional detected resources require a provider-specific reviewed module.');
  }
  lines.push('');
  return lines.join('\n');
}

export function compileEngineeringArtifacts(input: {
  analysis: SourceAnalysisIr;
  projectId?: string;
  targetProvider?: string;
}): EngineeringArtifactBundle {
  const projectId = input.projectId?.trim() || 'source-analysis';
  const bundle: EngineeringArtifactBundle = {
    analysis_ir: input.analysis,
    design_document: renderDesignDocument(input.analysis),
    test_inventory: buildTestInventory(input.analysis, projectId),
    test_scenario_pipeline: buildTestScenarioPipeline(input.analysis, projectId),
    iac_proposal: buildIacProposal(input.analysis, input.targetProvider),
  };
  validateEngineeringArtifacts(bundle);
  return bundle;
}

export function writeEngineeringArtifactBundle(
  bundle: EngineeringArtifactBundle,
  outputDir: string
): Record<string, string> {
  validateEngineeringArtifacts(bundle);
  const root = pathResolver.rootResolve(outputDir);
  const relativeRoot = path.relative(pathResolver.rootDir(), root).replaceAll(path.sep, '/');
  if (
    !relativeRoot.startsWith('active/shared/tmp/') &&
    !relativeRoot.startsWith('active/missions/')
  ) {
    throw new Error(
      'Engineering artifact output must stay under active/shared/tmp or active/missions.'
    );
  }
  safeMkdir(root, { recursive: true });
  const outputs: Record<string, string> = {
    analysis_ir: path.join(root, 'source-analysis-ir.json'),
    design_document: path.join(root, 'source-derived-design.md'),
    test_inventory: path.join(root, 'source-test-inventory.json'),
    test_scenario_pipeline: path.join(root, 'source-test-scenarios.json'),
    iac_proposal: path.join(root, 'iac-proposal.json'),
    iac_terraform: path.join(root, 'iac-proposal.tf'),
  };
  safeWriteFile(outputs.analysis_ir, json(bundle.analysis_ir));
  safeWriteFile(outputs.design_document, bundle.design_document);
  safeWriteFile(outputs.test_inventory, json(bundle.test_inventory));
  safeWriteFile(outputs.test_scenario_pipeline, json(bundle.test_scenario_pipeline));
  safeWriteFile(outputs.iac_proposal, json(bundle.iac_proposal));
  safeWriteFile(outputs.iac_terraform, bundle.iac_proposal.terraform);
  return Object.fromEntries(
    Object.entries(outputs).map(([key, value]) => [
      key,
      path.relative(pathResolver.rootDir(), value),
    ])
  );
}
