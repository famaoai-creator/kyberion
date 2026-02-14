const fs = require('fs');
const path = require('path');
const { logger } = require('./lib/core.cjs');

const schemasDir = path.resolve(__dirname, '..', 'schemas');

if (!fs.existsSync(schemasDir)) {
  logger.error('schemas/ directory not found');
  process.exit(1);
}

let errors = 0;
const files = fs.readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'));

for (const file of files) {
  const filePath = path.join(schemasDir, file);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const schema = JSON.parse(content);

    if (!schema.$schema) logger.warn(`${file}: Missing $schema field`);
    if (!schema.title) logger.warn(`${file}: Missing title field`);
    if (!schema.type) {
      logger.error(`${file}: Missing type field`);
      errors++;
    }

    logger.success(`${file}: Valid JSON Schema`);
  } catch (err) {
    logger.error(`${file}: ${err.message}`);
    errors++;
  }
}

if (files.length === 0) {
  logger.error('No schema files found');
  process.exit(1);
}

logger.info(`Validated ${files.length} schema files`);
if (errors > 0) {
  logger.error(`Found ${errors} errors`);
  process.exit(1);
} else {
  logger.success('All schemas are valid');
}
