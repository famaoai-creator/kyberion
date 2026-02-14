#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('action', {
    alias: 'a',
    type: 'string',
    default: 'status',
    choices: ['status', 'create-issue', 'sprint-plan', 'backlog-sync'],
    description: 'Action',
  })
  .option('input', { alias: 'i', type: 'string', description: 'Input JSON file' })
  .option('project', {
    alias: 'p',
    type: 'string',
    default: 'PROJ',
    description: 'Jira project key',
  })
  .option('dry-run', { type: 'boolean', default: true, description: 'Simulate without API calls' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function createIssue(input) {
  const data = input ? JSON.parse(fs.readFileSync(path.resolve(input), 'utf8')) : {};
  return {
    key: `${argv.project}-001`,
    type: data.type || 'Story',
    summary: data.summary || 'New issue',
    description: data.description || '',
    priority: data.priority || 'Medium',
    labels: data.labels || [],
    assignee: data.assignee || 'unassigned',
    status: 'created (dry-run)',
  };
}

function planSprint(input) {
  const data = input ? JSON.parse(fs.readFileSync(path.resolve(input), 'utf8')) : {};
  const stories = data.stories || [];
  const capacity = data.capacity || 40;
  const planned = [];
  let totalPoints = 0;
  for (const story of stories) {
    const points = story.points || 3;
    if (totalPoints + points <= capacity) {
      planned.push({ ...story, points, included: true });
      totalPoints += points;
    } else planned.push({ ...story, points, included: false });
  }
  return {
    sprintName: data.sprint || 'Sprint N',
    capacity,
    totalPoints,
    stories: planned,
    utilization: Math.round((totalPoints / capacity) * 100),
  };
}

function syncBacklog(input) {
  const data = input ? JSON.parse(fs.readFileSync(path.resolve(input), 'utf8')) : {};
  const requirements = data.requirements || [];
  return {
    synced: requirements.length,
    issues: requirements.map((r, i) => ({
      key: `${argv.project}-${100 + i}`,
      summary: r.title || r,
      type: 'Story',
      priority: r.priority || 'Medium',
      status: 'To Do',
    })),
  };
}

runSkill('jira-agile-assistant', () => {
  let actionResult;
  switch (argv.action) {
    case 'create-issue':
      actionResult = createIssue(argv.input);
      break;
    case 'sprint-plan':
      actionResult = planSprint(argv.input);
      break;
    case 'backlog-sync':
      actionResult = syncBacklog(argv.input);
      break;
    default:
      actionResult = {
        project: argv.project,
        status: 'connected (dry-run)',
        services: ['Issues', 'Sprints', 'Backlog'],
      };
  }
  const result = {
    action: argv.action,
    project: argv.project,
    mode: argv['dry-run'] ? 'dry-run' : 'live',
    result: actionResult,
    recommendations: argv['dry-run']
      ? ['Running in dry-run mode. Set --no-dry-run and configure Jira credentials to execute.']
      : [],
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
