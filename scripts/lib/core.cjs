const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

/**
 * Shared Utility Core for Gemini Skills
 * Provides standardized I/O, logging, and error handling.
 */

const logger = {
  info: (msg) => console.log(chalk.blue(' [INFO] ') + msg),
  success: (msg) => console.log(chalk.green(' [SUCCESS] ') + msg),
  warn: (msg) => console.log(chalk.yellow(' [WARN] ') + msg),
  error: (msg) => console.error(chalk.red(' [ERROR] ') + msg)
};

const fileUtils = {
  ensureDir: (dirPath) => {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  },
  readJson: (filePath) => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return null;
    }
  },
  writeJson: (filePath, data) => {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
};

const errorHandler = (err, context = '') => {
  logger.error(`${context}: ${err.message || err}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
};

module.exports = {
  logger,
  fileUtils,
  errorHandler
};
