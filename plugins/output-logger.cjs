// Example plugin: logs skill outputs to a file
const fs = require('fs');
const path = require('path');

const logFile = path.join(process.cwd(), 'work', 'plugin-output.log');

module.exports = {
  afterSkill(skillName, output) {
    try {
      const line =
        JSON.stringify({ skill: skillName, status: output.status, ts: new Date().toISOString() }) +
        '\n';
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line);
    } catch (_e) {}
  },
};
