/**
 * Plugin: Metrics Collector
 */

const executions: any[] = [];

export const beforeSkill = (_skillName: string, _args: any) => {
  // Track that skill started
};

export const afterSkill = (skillName: string, output: any) => {
  executions.push({
    skill: skillName,
    status: output.status,
    duration_ms: output.metadata ? output.metadata.duration_ms : 0,
    timestamp: new Date().toISOString(),
  });
};

export const getExecutions = () => {
  return executions;
};
