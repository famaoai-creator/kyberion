const fs = require('fs');
const path = require('path');
const { loadProjectStandards } = require('./config-loader.cjs');

const standards = loadProjectStandards();

/**
 * Recursively walk through a directory and yield file paths.
 * Automatically respects ignore lists from project_standards.json.
 * 
 * @param {string} dir - Directory to scan
 * @param {Object} options - Scan options (maxDepth, includeBinary, etc.)
 */
function* walk(dir, options = {}) {
    const { maxDepth = Infinity, currentDepth = 0 } = options;
    if (currentDepth > maxDepth) return;

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
        return; // Skip inaccessible directories
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        // Check ignore lists
        if (entry.isDirectory()) {
            if (standards.ignore_dirs.includes(entry.name)) continue;
            yield* walk(fullPath, { ...options, currentDepth: currentDepth + 1 });
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (standards.ignore_extensions.includes(ext)) continue;
            yield fullPath;
        }
    }
}

/**
 * Get all files in a directory as an array.
 */
function getAllFiles(dir, options = {}) {
    return Array.from(walk(dir, options));
}

module.exports = {
    walk,
    getAllFiles
};
