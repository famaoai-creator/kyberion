const fs = require('fs');
const path = require('path');
const { globSync } = require('glob');
const yaml = require('js-yaml');
const chalk = require('chalk');

const rootDir = process.argv[2] || '.';

// --- Knowledge Layer Paths ---
const KNOWLEDGE_DIR = path.join(__dirname, '../../knowledge');
const PATTERNS_FILE = path.join(KNOWLEDGE_DIR, 'schema/detection-patterns.yaml');
const COMMON_EXCLUDES_FILE = path.join(KNOWLEDGE_DIR, 'common/exclude-patterns.yaml');

// --- Load Configuration from Knowledge Layer ---

function loadConfig() {
  try {
    return yaml.load(fs.readFileSync(PATTERNS_FILE, 'utf8'));
  } catch (e) {
    console.error(chalk.yellow(`Warning: Could not load patterns from ${PATTERNS_FILE}: ${e.message}`));
    // Fallback to minimal patterns
    return {
      patterns: [
        { glob: '**/*.sql', type: 'sql' },
        { glob: '**/schema.prisma', type: 'prisma' },
        { glob: '**/openapi.yaml', type: 'openapi' }
      ],
      exclude: { directories: ['node_modules', 'dist', 'build'] },
      display: { max_content_length: 20000 }
    };
  }
}

function loadExcludes() {
  try {
    const common = yaml.load(fs.readFileSync(COMMON_EXCLUDES_FILE, 'utf8'));
    return common.directories || [];
  } catch (e) {
    return ['node_modules', 'dist', 'build'];
  }
}

const config = loadConfig();
const commonExcludes = loadExcludes();

// Merge exclude patterns
const excludeDirs = [...new Set([
  ...(config.exclude?.directories || []),
  ...commonExcludes
])];

const ignorePatterns = excludeDirs.map(d => `${d}/**`);
if (config.exclude?.patterns) {
  ignorePatterns.push(...config.exclude.patterns);
}

// Extract glob patterns
const patterns = config.patterns.map(p => p.glob);
const patternTypes = config.patterns.reduce((acc, p) => {
  acc[p.glob] = { type: p.type, description: p.description };
  return acc;
}, {});

const displayConfig = config.display || { max_content_length: 20000 };

// --- Main ---

console.log(chalk.bold.cyan(`\n🔍 Schema Inspector\n`));
console.log(chalk.gray(`Searching for schema definitions in: ${path.resolve(rootDir)}`));
console.log(chalk.gray(`Patterns loaded: ${patterns.length}\n`));

const files = globSync(patterns, {
  cwd: rootDir,
  ignore: ignorePatterns,
  nodir: true
});

if (files.length === 0) {
  console.log(chalk.yellow("No schema files found."));
  process.exit(0);
}

console.log(chalk.green(`Found ${files.length} schema file(s):\n`));

// Group files by type
const filesByType = {};
files.forEach(file => {
  // Find matching pattern to get type
  let fileType = 'unknown';
  for (const pattern of config.patterns) {
    // Simple check if file matches pattern
    const patternBase = pattern.glob.replace('**/', '').replace('*', '');
    if (file.includes(patternBase) || file.endsWith(patternBase.replace('*', ''))) {
      fileType = pattern.type;
      break;
    }
  }

  if (!filesByType[fileType]) filesByType[fileType] = [];
  filesByType[fileType].push(file);
});

// Display summary
Object.entries(filesByType).forEach(([type, typeFiles]) => {
  console.log(chalk.cyan(`  [${type}] ${typeFiles.length} file(s)`));
  typeFiles.forEach(f => console.log(chalk.gray(`    - ${f}`)));
});

console.log('');

// Display content
files.forEach(file => {
  console.log(chalk.bold.yellow(`\n--- [SCHEMA FILE] ${file} ---\n`));
  try {
    const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
    if (content.length > displayConfig.max_content_length) {
      console.log(content.substring(0, displayConfig.max_content_length));
      console.log(chalk.gray(`\n${displayConfig.truncate_message || '... (Truncated)'}`));
    } else {
      console.log(content);
    }
  } catch (e) {
    console.error(chalk.red(`Error reading ${file}: ${e.message}`));
  }
});

// Output JSON summary if requested
if (process.argv.includes('--json')) {
  const report = {
    timestamp: new Date().toISOString(),
    rootDir: path.resolve(rootDir),
    totalFiles: files.length,
    filesByType,
    files
  };
  console.log('\n' + JSON.stringify(report, null, 2));
}
