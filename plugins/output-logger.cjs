// Example plugin: logs skill outputs to a file
const { safeAppendFileSync, safeMkdir } = require('@agent/core/secure-io');
const fs = require('fs');
const path = require('path');

const logFile = path.join(process.cwd(), 'work', 'plugin-output.log');

module.exports = {
  afterSkill(skillName, output) {
    try {
      const line =
        JSON.stringify({ skill: skillName, status: output.status, ts: new Date().toISOString() }) +
        '\n';
      const dir = path.dirname(logFile);
      if (!fs.existsSync(dir)) {
        safeMkdir(dir, { recursive: true });
      }
      safeAppendFileSync(logFile, line);
    } catch (_e) {}
  },
};
