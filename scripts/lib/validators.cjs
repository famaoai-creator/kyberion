const fs = require('fs');
const path = require('path');

/**
 * Shared input validators for Gemini skills.
 * Provides safe file path validation, JSON parsing, and argument checking.
 *
 * Usage:
 *   const { validateFilePath, safeJsonParse, requireArgs } = require('../../scripts/lib/validators.cjs');
 *   const filePath = validateFilePath(argv.input);
 *   const data = safeJsonParse(rawString, 'headers');
 *
 * @module validators
 */

/**
 * Validate that a file path exists and is a regular file.
 * @param {string} filePath - Path to validate
 * @param {string} [label='input'] - Label for error messages
 * @returns {string} Resolved absolute path
 * @throws {Error} If path is missing, not found, or not a file
 */
function validateFilePath(filePath, label = 'input') {
  if (!filePath) {
    throw new Error(`Missing required ${label} file path`);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }
  return resolved;
}

/**
 * Validate that a directory path exists and is a directory.
 * @param {string} dirPath - Path to validate
 * @param {string} [label='directory'] - Label for error messages
 * @returns {string} Resolved absolute path
 * @throws {Error} If path is missing, not found, or not a directory
 */
function validateDirPath(dirPath, label = 'directory') {
  if (!dirPath) {
    throw new Error(`Missing required ${label} path`);
  }
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Safely parse a JSON string with descriptive error messages.
 * @param {string} jsonString - String to parse
 * @param {string} [label='JSON'] - Label for error messages
 * @returns {*} Parsed value
 * @throws {Error} If parsing fails
 */
function safeJsonParse(jsonString, label = 'JSON') {
  try {
    return JSON.parse(jsonString);
  } catch (err) {
    throw new Error(`Invalid ${label}: ${err.message}`);
  }
}

/**
 * Read and parse a JSON file safely.
 * @param {string} filePath - Path to JSON file
 * @param {string} [label='JSON file'] - Label for error messages
 * @returns {*} Parsed JSON content
 * @throws {Error} If file not found or JSON invalid
 */
function readJsonFile(filePath, label = 'JSON file') {
  const resolved = validateFilePath(filePath, label);
  const content = fs.readFileSync(resolved, 'utf8');
  return safeJsonParse(content, label);
}

/**
 * Validate that required arguments are present.
 * @param {Object|string[]} argvOrRequired - Arguments object or list of required names
 * @param {string[]} [requiredList] - List of required argument names (if argv provided first)
 * @throws {Error} If any required argument is missing
 */
function requireArgs(argvOrRequired, requiredList) {
  let argv, required;

  if (Array.isArray(argvOrRequired)) {
    // Legacy support: fetch argv automatically if not provided
    const yargs = require('yargs/yargs')(process.argv.slice(2));
    argv = yargs.argv;
    required = argvOrRequired;
  } else {
    argv = argvOrRequired;
    required = requiredList || [];
  }

  if (!argv) throw new Error('Arguments object (argv) is undefined.');
  if (!Array.isArray(required)) throw new Error('Required arguments list must be an array.');

  const missing = required.filter((name) => argv[name] === undefined || argv[name] === null);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.join(', ')}`);
  }
  return argv;
}

module.exports = { validateFilePath, validateDirPath, safeJsonParse, readJsonFile, requireArgs };
