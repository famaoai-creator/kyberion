// Example plugin: collects skill execution metrics
const executions = [];

module.exports = {
  beforeSkill(_skillName, _args) {
    // Track that skill started
  },
  afterSkill(skillName, output) {
    executions.push({
      skill: skillName,
      status: output.status,
      duration_ms: output.metadata ? output.metadata.duration_ms : 0,
      timestamp: new Date().toISOString(),
    });
  },
  getExecutions() {
    return executions;
  },
};
