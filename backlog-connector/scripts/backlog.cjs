#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSkillAsync } = require('@gemini/core');
const { requireArgs } = require('@gemini/core/validators');

runSkillAsync('backlog-connector', async () => {
    const argv = requireArgs(['project']);
    
    // 1. Load Skill Knowledge
    const configPath = path.resolve(__dirname, '../../knowledge/skills/backlog-connector/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // 2. Load Credentials & Inventory
    const inventory = JSON.parse(fs.readFileSync('../../knowledge/confidential/connections/inventory.json', 'utf8'));
    const backlogCreds = fs.readFileSync('../../knowledge/personal/connections/backlog.md', 'utf8');
    const apiKey = backlogCreds.match(new RegExp(config.credential_pattern))[1];
    
    const projectInfo = inventory.systems.backlog.projects[argv.project];
    if (!projectInfo) throw new Error(`Project ${argv.project} not found in inventory.`);

    // 3. Execute API Call
    const url = `${inventory.systems.backlog.space_url}${config.endpoints.issues}?apiKey=${apiKey}&projectId[]=${projectInfo.id}&count=100`;
    const response = execSync(`curl -s "${url}"`, { encoding: 'utf8' });
    const data = JSON.parse(response);

    return { project: argv.project, count: data.length };
});
