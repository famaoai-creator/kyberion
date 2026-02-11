#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
    .option('project', { alias: 'p', type: 'string', demandOption: true })
    .argv;

runAsyncSkill('backlog-connector', async () => {
    // 1. Load Credentials & Inventory
    const inventory = JSON.parse(fs.readFileSync('../../knowledge/confidential/connections/inventory.json', 'utf8'));
    const backlogCreds = fs.readFileSync('../../knowledge/personal/connections/backlog.md', 'utf8');
    const apiKey = backlogCreds.match(/API Key`: `([^`]+)`/)[1];
    
    const projectInfo = inventory.systems.backlog.projects[argv.project];
    if (!projectInfo) throw new Error(`Project ${argv.project} not found in inventory.`);

    // 2. Fetch Issues
    const url = `${inventory.systems.backlog.space_url}/api/v2/issues?apiKey=${apiKey}&projectId[]=${projectInfo.id}&count=100`;
    console.log(`Fetching from ${argv.project} (ID: ${projectInfo.id})...`);
    
    const response = execSync(`curl -s "${url}"`, { encoding: 'utf8' });
    const data = JSON.parse(response);

    if (argv.out) {
        fs.writeFileSync(argv.out, JSON.stringify(data, null, 2));
    }

    return { 
        project: argv.project, 
        count: data.length, 
        message: `Successfully fetched ${data.length} issues.` 
    };
});
