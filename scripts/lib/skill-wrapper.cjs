/**
 * Skill I/O wrapper - standardizes skill output to match schemas/skill-output.schema.json
 *
 * Usage (sync):
 *   const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
 *   runSkill('my-skill', () => { return { result: 'data' }; });
 *
 * Usage (async):
 *   const { runSkillAsync } = require('../../scripts/lib/skill-wrapper.cjs');
 *   runSkillAsync('my-skill', async () => { return { result: 'data' }; });
 */

// --- Plugin Hook System & Metrics ---
const path = require('path');
const fs = require('fs');
const { logger } = require('./core.cjs');

// Lazy-load metrics to avoid circular deps
let _metrics = null;
function _getMetrics() {
  if (_metrics === null) {
    try { _metrics = require('./metrics.cjs').metrics; } catch (_) { _metrics = false; }
  }
  return _metrics || null;
}

const _hooks = { before: [], after: [] };
let _hooksLoaded = false;

function _loadHooks() {
  if (_hooksLoaded) return;
  _hooksLoaded = true;
  const configPath = path.join(process.cwd(), '.gemini-plugins.json');
  if (!fs.existsSync(configPath)) return;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (Array.isArray(config.plugins)) {
      for (const plugin of config.plugins) {
        const mod = typeof plugin === 'string' ? require(path.resolve(plugin)) : plugin;
        if (typeof mod.beforeSkill === 'function') _hooks.before.push(mod.beforeSkill);
        if (typeof mod.afterSkill === 'function') _hooks.after.push(mod.afterSkill);
      }
    }
  } catch (_) { /* Ignore plugin load errors to avoid blocking skill execution */ }
}

function _runBeforeHooks(skillName, args) {
  _loadHooks();
  for (const hook of _hooks.before) {
    try { hook(skillName, args); } catch (_) {}
  }
}

function _runAfterHooks(skillName, output) {
  for (const hook of _hooks.after) {
    try { hook(skillName, output); } catch (_) {}
  }
  return output;
}

// --- SKILL.md Frontmatter Parser ---

function _findSkillMd(skillName) {
  const rootDir = path.resolve(__dirname, '../..');
  const skillMd = path.join(rootDir, skillName, 'SKILL.md');
  if (fs.existsSync(skillMd)) return skillMd;
  return null;
}

function _parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  let currentKey = null;
  let inArray = false;
  let arrayItems = [];

  for (const line of match[1].split('\n')) {
    if (inArray) {
      const itemMatch = line.match(/^\s+-\s+(.*)/);
      if (itemMatch) {
        // Array item - could be an object or simple value
        const val = itemMatch[1].trim();
        if (val.startsWith('name:')) {
          // Start of a new object in array
          const obj = {};
          const kvMatch = val.match(/^(\w+):\s*(.+)/);
          if (kvMatch) obj[kvMatch[1]] = kvMatch[2].trim();
          arrayItems.push(obj);
        } else if (arrayItems.length > 0 && typeof arrayItems[arrayItems.length - 1] === 'object' && !Array.isArray(arrayItems[arrayItems.length - 1])) {
          // Property of current object
          const kvMatch = val.match(/^(\w+):\s*(.+)/);
          if (kvMatch) {
            let v = kvMatch[2].trim();
            if (v === 'true') v = true;
            else if (v === 'false') v = false;
            else if (/^\d+$/.test(v)) v = Number(v);
            else if (v.startsWith('[') && v.endsWith(']')) {
              v = v.slice(1, -1).split(',').map(s => s.trim());
            }
            arrayItems[arrayItems.length - 1][kvMatch[1]] = v;
          }
        } else {
          arrayItems.push(val);
        }
        continue;
      }
      // Check if it's an indented property of the last object
      const propMatch = line.match(/^\s{4,}(\w+):\s*(.+)/);
      if (propMatch && arrayItems.length > 0 && typeof arrayItems[arrayItems.length - 1] === 'object') {
        let v = propMatch[2].trim();
        if (v === 'true') v = true;
        else if (v === 'false') v = false;
        else if (/^\d+$/.test(v)) v = Number(v);
        else if (v.startsWith('[') && v.endsWith(']')) {
          v = v.slice(1, -1).split(',').map(s => s.trim());
        }
        arrayItems[arrayItems.length - 1][propMatch[1]] = v;
        continue;
      }
      // End of array
      fm[currentKey] = arrayItems;
      inArray = false;
      arrayItems = [];
    }

    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '') {
        // Could be start of array or multi-line
        inArray = true;
        arrayItems = [];
      } else {
        fm[currentKey] = val;
      }
    }
  }
  if (inArray && currentKey) {
    fm[currentKey] = arrayItems;
  }
  return fm;
}

function _showHelp(skillName) {
  const mdPath = _findSkillMd(skillName);
  if (!mdPath) {
    console.log(`${skillName} -- no SKILL.md found. See the skill directory for usage.`);
    process.exit(0);
  }

  const content = fs.readFileSync(mdPath, 'utf8');
  const fm = _parseFrontmatter(content);
  const desc = fm.description || '';
  const args = fm.arguments;

  console.log(`\n${skillName} -- ${desc}\n`);

  // Find the script file
  const rootDir = path.resolve(__dirname, '../..');
  const scriptsDir = path.join(rootDir, skillName, 'scripts');
  let scriptName = 'main.cjs';
  if (fs.existsSync(scriptsDir)) {
    const files = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.cjs') || f.endsWith('.js'));
    if (files.length > 0) scriptName = files[0];
  }

  console.log(`Usage:`);
  console.log(`  node ${skillName}/scripts/${scriptName} [options]\n`);

  if (Array.isArray(args) && args.length > 0) {
    console.log('Arguments:');
    for (const arg of args) {
      const nameStr = arg.positional
        ? `  <${arg.name}>`
        : `  --${arg.name}${arg.short ? ', -' + arg.short : ''}`;
      const reqStr = arg.required ? ' (required)' : '';
      const defStr = arg.default !== undefined && arg.default !== null ? ` [default: ${arg.default}]` : '';
      const choicesStr = arg.choices ? ` {${arg.choices.join(', ')}}` : '';
      const descStr = arg.description || '';
      console.log(`${nameStr.padEnd(24)} ${descStr}${choicesStr}${reqStr}${defStr}`);
    }
    console.log('');
  } else {
    console.log('Run with --help via yargs or see SKILL.md for arguments.\n');
  }

  // Show playbook if available
  const playbooksDir = path.join(rootDir, 'knowledge/orchestration/mission-playbooks');
  if (fs.existsSync(playbooksDir)) {
    try {
      const playbooks = fs.readdirSync(playbooksDir).filter(f => f.endsWith('.md'));
      if (playbooks.length > 0) {
        console.log(`Playbooks:  ${playbooks.map(p => p.replace('.md', '')).join(', ')}`);
      }
    } catch (_e) { /* ignore */ }
  }

  console.log(`More info:  npm run cli -- info ${skillName}`);
  console.log('');
  process.exit(0);
}

function _checkHelp(skillName) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    _showHelp(skillName);
  }
}

// --- Error Suggestion Engine ---

function _addSuggestion(errorObj, skillName) {
  const msg = errorObj.message || '';
  if (msg.includes('Cannot find module')) {
    errorObj.suggestion = 'Run: npm install (from project root)';
  } else if (msg.includes('Missing required argument') || msg.includes('required')) {
    errorObj.suggestion = `Run: node ${skillName}/scripts/<script>.cjs --help`;
  } else if (msg.includes('ENOENT') || msg.includes('no such file') || msg.includes('File not found')) {
    errorObj.suggestion = 'Check that the file path exists and is accessible';
  } else if (msg.includes('EACCES') || msg.includes('permission denied')) {
    errorObj.suggestion = 'Check file permissions or run with appropriate access';
  } else if (msg.includes('SyntaxError') || msg.includes('Unexpected token')) {
    errorObj.suggestion = 'Check input file format - it may be malformed';
  }
  return errorObj;
}

// --- Human-Readable Format ---

function _formatHuman(output) {
  const chalk = require('chalk');
  const status = output.status === 'success' ? chalk.green('\u2705') : chalk.red('\u274c');
  const dur = output.metadata ? chalk.dim(`in ${output.metadata.duration_ms}ms`) : '';
  console.log(`\n${status} ${chalk.bold(output.skill)} ${output.status} ${dur}\n`);

  if (output.data) {
    if (typeof output.data === 'string') {
      console.log(output.data);
    } else {
      console.log(JSON.stringify(output.data, null, 2));
    }
  }
  if (output.error) {
    const retryIcon = output.error.retryable ? '\u21bb\ufe0f' : '\u26d4\ufe0f';
    console.log(chalk.red.bold(`Error [${output.error.code}]: `) + output.error.message);
    if (output.error.suggestion) {
      console.log(chalk.cyan.bold('\n\u2139\ufe0f  Next Steps:'));
      console.log(chalk.cyan(`  ${output.error.suggestion}\n`));
    }
    console.log(chalk.dim(`${retryIcon} Retryable: ${output.error.retryable ? 'Yes' : 'No'}\n`));
  }
}

function _isHumanFormat() {
  return process.env.GEMINI_FORMAT === 'human' || process.argv.includes('--format=human');
}

// Lazy-load Ajv for validation
let _ajv = null;
let _schema = null;
function _validateOutput(output) {
  try {
    if (_ajv === null) {
      const Ajv = require('ajv');
      _ajv = new Ajv({ allErrors: true });
      _schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schemas/skill-output.schema.json'), 'utf8'));
    }
    const validate = _ajv.compile(_schema);
    if (!validate(output)) {
      logger.warn(`[${output.skill}] Output schema validation failed: ${JSON.stringify(validate.errors)}`);
      return false;
    }
    return true;
  } catch (_) {
    // If Ajv or schema is not available, skip validation gracefully
    return true;
  }
}

/**
 * Build a standard output envelope.
 * @param {string} skillName - Name of the skill
 * @param {'success'|'error'} status - Execution status
 * @param {*} dataOrError - Result data or error object
 * @param {number} startTime - Timestamp from Date.now()
 * @returns {Object} Standard skill output matching skill-output.schema.json
 */
function buildOutput(skillName, status, dataOrError, startTime) {
  const { fileUtils } = require('./core.cjs');
  const { detectTier } = require('./tier-guard.cjs');
  
  const base = {
    skill: skillName,
    status,
    metadata: {
      duration_ms: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      role: fileUtils.getCurrentRole(),
      execution_tier: detectTier(process.cwd()), // Current working context tier
      mission_id: process.env.MISSION_ID || null,
    },
  };
  if (status === 'success') {
    base.data = dataOrError;
  } else {
    base.error = {
      code: dataOrError.code || 'EXECUTION_ERROR',
      message: dataOrError.message || String(dataOrError),
    };
    
    // SRE: Detect retryable conditions (e.g. timeouts, locked files)
    const msg = base.error.message.toLowerCase();
    base.error.retryable = msg.includes('timeout') || msg.includes('busy') || msg.includes('locked') || msg.includes('econnreset');
    
    _addSuggestion(base.error, skillName);
    logger.error(`[${skillName}] ${base.error.message}`);
  }

  // Sovereign Tier Guarding: Prevent Personal/Confidential data leakage
  const { validateSovereignBoundary } = require('./tier-guard.cjs');
  const rawOutput = JSON.stringify(base);
  const guard = validateSovereignBoundary(rawOutput);
  if (!guard.safe) {
    console.error(`\n[SECURITY ALERT] Sovereign boundary violation in ${skillName}! Output blocked.`);
    return {
      skill: skillName,
      status: 'error',
      error: { code: 'SOVEREIGN_VIOLATION', message: 'Output contains forbidden tokens.' },
      metadata: base.metadata
    };
  }

  // Validate output against schema
  _validateOutput(base);

  return base;
}

/**
 * Wrap a synchronous skill function in standard output format.
 * @param {string} skillName - Name of the skill
 * @param {Function} fn - Synchronous function that returns data or throws
 * @returns {Object} Standard skill output
 */
function wrapSkill(skillName, fn) {
  _runBeforeHooks(skillName, process.argv);
  const startTime = Date.now();
  try {
    const output = buildOutput(skillName, 'success', fn(), startTime);
    return _runAfterHooks(skillName, output);
  } catch (err) {
    const output = buildOutput(skillName, 'error', err, startTime);
    return _runAfterHooks(skillName, output);
  }
}

/**
 * Wrap an async skill function in standard output format.
 * @param {string} skillName - Name of the skill
 * @param {Function} fn - Async function that returns data or throws
 * @returns {Promise<Object>} Standard skill output
 */
async function wrapSkillAsync(skillName, fn) {
  _runBeforeHooks(skillName, process.argv);
  const startTime = Date.now();
  try {
    const output = buildOutput(skillName, 'success', await fn(), startTime);
    return _runAfterHooks(skillName, output);
  } catch (err) {
    const output = buildOutput(skillName, 'error', err, startTime);
    return _runAfterHooks(skillName, output);
  }
}

/**
 * Print output in the appropriate format.
 * @param {Object} output - Standard skill output
 */
function _printOutput(output) {
  if (_isHumanFormat()) {
    _formatHuman(output);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

/**
 * Run a synchronous skill, print JSON result to stdout, exit 1 on error.
 * @param {string} skillName - Name of the skill
 * @param {Function} fn - Synchronous function that returns data or throws
 * @returns {Object} Standard skill output
 */
function runSkill(skillName, fn) {
  const { _fileCache } = require('./core.cjs');
  if (_fileCache) _fileCache.resetStats(); // Start fresh for this execution

  _checkHelp(skillName);
  const output = wrapSkill(skillName, fn);
  const m = _getMetrics();
  
  if (m) {
    const cacheStats = _fileCache ? _fileCache.getStats() : null;
    m.record(skillName, output.metadata.duration_ms, output.status, { cacheStats });
  }
  
  _printOutput(output);
  if (output.status === 'error') process.exit(1);
  return output;
}

/**
 * Run an async skill, print JSON result to stdout, exit 1 on error.
 * @param {string} skillName - Name of the skill
 * @param {Function} fn - Async function that returns data or throws
 * @returns {Promise<Object>} Standard skill output
 */
async function runSkillAsync(skillName, fn) {
  const { _fileCache } = require('./core.cjs');
  if (_fileCache) _fileCache.resetStats();

  _checkHelp(skillName);
  const output = await wrapSkillAsync(skillName, fn);
  const m = _getMetrics();
  
  if (m) {
    const cacheStats = _fileCache ? _fileCache.getStats() : null;
    m.record(skillName, output.metadata.duration_ms, output.status, { cacheStats });
  }
  
  _printOutput(output);
  if (output.status === 'error') process.exit(1);
  return output;
}

// runAsyncSkill is an alias for runSkillAsync for convenience
const runAsyncSkill = runSkillAsync;

module.exports = { wrapSkill, wrapSkillAsync, runSkill, runSkillAsync, runAsyncSkill };
