const fs = require('fs');
const { execSync } = require('child_process');

const API_KEY = process.env.GEMINI_INCIDENT_API_KEY;
const SPACE_URL = process.env.GEMINI_INCIDENT_SPACE_URL;
const PROJECT_ID = process.env.GEMINI_INCIDENT_PROJECT_ID; // NBS_INCIDENT

if (!API_KEY) {
    console.error('ERROR: GEMINI_INCIDENT_API_KEY environment variable is not set.');
    process.exit(1);
}

async function fetchAllIssues() {
    const allIssues = [];
    let offset = 0;
    const count = 100;

    console.log('Starting full data collection from Backlog...');

    while (true) {
        const url = `${SPACE_URL}/api/v2/issues?apiKey=${API_KEY}&projectId[]=${PROJECT_ID}&count=${count}&offset=${offset}&sort=created&order=desc`;
        try {
            const response = execSync(`curl -s "${url}"`, { encoding: 'utf8' });
            const issues = JSON.parse(response);
            
            if (issues.length === 0) break;
            
            allIssues.push(...issues);
            console.log(`Fetched ${allIssues.length} issues...`);
            
            if (issues.length < count) break;
            offset += count;
        } catch (_e) {
            console.error('Fetch failed:', e.message);
            break;
        }
    }

    fs.writeFileSync('work/nbs_incidents_all.json', JSON.stringify(allIssues, null, 2));
    console.log(`Total ${allIssues.length} issues saved to work/nbs_incidents_all.json`);
}

fetchAllIssues();
