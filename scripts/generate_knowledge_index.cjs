const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { logger, fileUtils, errorHandler } = require('./lib/core.cjs');

/**
 * Knowledge Index Generator
 * Scans knowledge/ directory and generates _index.md (human-readable catalog)
 * and _manifest.json (structured index data) for the knowledge base.
 *
 * Usage: node scripts/generate_knowledge_index.cjs
 */

const rootDir = path.resolve(__dirname, '..');
const knowledgeDir = path.join(rootDir, 'knowledge');
const indexFile = path.join(knowledgeDir, '_index.md');
const manifestFile = path.join(knowledgeDir, '_manifest.json');

// Tier classification based on top-level directory names
const TIER_MAP = {
  personal: 'personal',
  confidential: 'confidential',
};

const STALENESS_THRESHOLD_DAYS = 365;

/**
 * Recursively collect all knowledge files (.json, .yaml, .yml, .md)
 * within the given directory.
 * @param {string} dir - Directory to scan
 * @param {string[]} [result=[]] - Accumulator for file paths
 * @returns {string[]} Array of absolute file paths
 */
function collectFiles(dir, result = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, result);
    } else if (/\.(json|ya?ml|md)$/.test(entry.name)) {
      // Skip generated output files
      if (entry.name === '_index.md' || entry.name === '_manifest.json') continue;
      result.push(fullPath);
    }
  }
  return result;
}

/**
 * Determine the tier (personal / confidential / public) based on the
 * top-level subdirectory under knowledge/.
 * @param {string} relPath - Path relative to knowledge/
 * @returns {string} Tier label
 */
function classifyTier(relPath) {
  const topDir = relPath.split(path.sep)[0];
  return TIER_MAP[topDir] || 'public';
}

/**
 * Attempt to extract a human-readable title or description from a file.
 * - JSON: first top-level key name
 * - YAML: value of "name" key, or first top-level key
 * - Markdown: first heading (# ...) or first non-empty line
 * @param {string} filePath - Absolute path to the file
 * @param {string} ext - File extension (.json, .yaml, .yml, .md)
 * @returns {string} Extracted title or empty string
 */
function extractTitle(filePath, ext) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (ext === '.json') {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const keys = Object.keys(parsed);
        if (keys.length > 0) {
          // If the first key looks like a title field, use its value
          if (['title', 'name', 'description'].includes(keys[0].toLowerCase())) {
            return String(parsed[keys[0]]).substring(0, 120);
          }
          return keys[0];
        }
      }
      return '';
    }

    if (ext === '.yaml' || ext === '.yml') {
      const parsed = yaml.load(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        if (parsed.name) return String(parsed.name).substring(0, 120);
        if (parsed.title) return String(parsed.title).substring(0, 120);
        if (parsed.description) return String(parsed.description).substring(0, 120);
        const keys = Object.keys(parsed);
        if (keys.length > 0) return keys[0];
      }
      // Fallback: first non-comment, non-empty line
      const firstLine = raw.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'));
      return firstLine ? firstLine.trim().substring(0, 120) : '';
    }

    if (ext === '.md') {
      const lines = raw.split('\n');
      // Look for the first heading
      for (const line of lines) {
        const match = line.match(/^#{1,6}\s+(.+)/);
        if (match) return match[1].trim().substring(0, 120);
      }
      // Fallback: first non-empty line
      const first = lines.find((l) => l.trim());
      return first ? first.trim().substring(0, 120) : '';
    }
  } catch {
    // Silently ignore parse errors
  }
  return '';
}

/**
 * Format byte size to a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
try {
  logger.info('Scanning knowledge/ directory...');

  const files = collectFiles(knowledgeDir);
  logger.info(`Found ${files.length} knowledge files.`);

  const now = Date.now();
  const stalenessMs = STALENESS_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  // Build entries
  const entries = files.map((absPath) => {
    const relPath = path.relative(knowledgeDir, absPath);
    const ext = path.extname(absPath).toLowerCase();
    const stat = fs.statSync(absPath);
    const modifiedMs = stat.mtimeMs;
    const modifiedDate = new Date(modifiedMs).toISOString().slice(0, 10);
    const isStale = now - modifiedMs > stalenessMs;
    const tier = classifyTier(relPath);
    const title = extractTitle(absPath, ext);
    const sizeBytes = stat.size;

    return {
      path: relPath,
      ext,
      tier,
      title,
      sizeBytes,
      sizeHuman: formatSize(sizeBytes),
      modifiedDate,
      isStale,
    };
  });

  // Sort: tier order (personal -> confidential -> public), then path
  const tierOrder = { personal: 0, confidential: 1, public: 2 };
  entries.sort((a, b) => {
    const t = (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9);
    if (t !== 0) return t;
    return a.path.localeCompare(b.path);
  });

  // Compute summary stats
  const tierCounts = {};
  const tierSizes = {};
  let totalSize = 0;
  const staleFiles = [];

  for (const e of entries) {
    tierCounts[e.tier] = (tierCounts[e.tier] || 0) + 1;
    tierSizes[e.tier] = (tierSizes[e.tier] || 0) + e.sizeBytes;
    totalSize += e.sizeBytes;
    if (e.isStale) staleFiles.push(e);
  }

  // -----------------------------------------------------------------------
  // Generate _index.md
  // -----------------------------------------------------------------------
  const mdLines = [];
  mdLines.push('# Knowledge Base Index');
  mdLines.push('');
  mdLines.push(
    `> Auto-generated by \`scripts/generate_knowledge_index.cjs\` on ${new Date().toISOString().slice(0, 10)}.`
  );
  mdLines.push('> Do not edit manually.');
  mdLines.push('');

  // Summary
  mdLines.push('## Summary');
  mdLines.push('');
  mdLines.push(`| Metric | Value |`);
  mdLines.push(`| ------ | ----- |`);
  mdLines.push(`| Total files | ${entries.length} |`);
  mdLines.push(`| Total size | ${formatSize(totalSize)} |`);
  for (const tier of ['personal', 'confidential', 'public']) {
    if (tierCounts[tier]) {
      mdLines.push(`| ${tier} files | ${tierCounts[tier]} (${formatSize(tierSizes[tier])}) |`);
    }
  }
  if (staleFiles.length > 0) {
    mdLines.push(`| Stale files (>${STALENESS_THRESHOLD_DAYS} days) | ${staleFiles.length} |`);
  }
  mdLines.push('');

  // File table
  mdLines.push('## File Catalog');
  mdLines.push('');
  mdLines.push('| Tier | Path | Title / Key | Size | Modified | Stale? |');
  mdLines.push('| ---- | ---- | ----------- | ---- | -------- | ------ |');

  for (const e of entries) {
    const staleFlag = e.isStale ? 'Yes' : '';
    const safeTitle = (e.title || '-').replace(/\|/g, '\\|');
    mdLines.push(
      `| ${e.tier} | ${e.path} | ${safeTitle} | ${e.sizeHuman} | ${e.modifiedDate} | ${staleFlag} |`
    );
  }
  mdLines.push('');

  // Staleness warnings
  if (staleFiles.length > 0) {
    mdLines.push('## Staleness Warnings');
    mdLines.push('');
    mdLines.push(
      `The following ${staleFiles.length} file(s) have not been updated in over ${STALENESS_THRESHOLD_DAYS} days and may need review:`
    );
    mdLines.push('');
    for (const e of staleFiles) {
      mdLines.push(`- **${e.path}** (last modified: ${e.modifiedDate})`);
    }
    mdLines.push('');
  }

  fs.writeFileSync(indexFile, mdLines.join('\n'), 'utf8');
  logger.success(`Generated ${indexFile}`);

  // -----------------------------------------------------------------------
  // Generate _manifest.json
  // -----------------------------------------------------------------------
  const manifest = {
    generated_at: new Date().toISOString(),
    generator: 'scripts/generate_knowledge_index.cjs',
    summary: {
      total_files: entries.length,
      total_size_bytes: totalSize,
      total_size_human: formatSize(totalSize),
      by_tier: {},
      stale_count: staleFiles.length,
      staleness_threshold_days: STALENESS_THRESHOLD_DAYS,
    },
    files: entries.map((e) => ({
      path: e.path,
      ext: e.ext,
      tier: e.tier,
      title: e.title || null,
      size_bytes: e.sizeBytes,
      size_human: e.sizeHuman,
      modified_date: e.modifiedDate,
      is_stale: e.isStale,
    })),
  };

  for (const tier of ['personal', 'confidential', 'public']) {
    if (tierCounts[tier]) {
      manifest.summary.by_tier[tier] = {
        count: tierCounts[tier],
        size_bytes: tierSizes[tier],
        size_human: formatSize(tierSizes[tier]),
      };
    }
  }

  fileUtils.writeJson(manifestFile, manifest);
  logger.success(`Generated ${manifestFile}`);

  logger.info('Knowledge index generation complete.');
} catch (_err) {
  errorHandler(err, 'Knowledge Index Generation Failed');
}
