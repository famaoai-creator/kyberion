#!/usr/bin/env node

/**
 * github-repo-auditor/scripts/audit_repos.cjs
 * Fetches and classifies organization repositories using GitHub CLI (gh).
 * Enhanced Mapping v2.0
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'knowledge/confidential/context/github-repo-auditor/config.json'), 'utf8')); const ORG = config.org;
const LIMIT = 1000;

function audit() {
  console.log(`Scanning organization: ${ORG}...`);
  
  try {
    const rawData = execSync(`gh repo list ${ORG} --limit ${LIMIT} --json name,description,pushedAt,isArchived`, { encoding: 'utf8' });
    const repos = JSON.parse(rawData);
    
    const mapping = {
      'Customer Portal (CP)': [],
      'AuthSystem (Auth)': [],
      'Identity Verification Solution': [],
      'Auth Infrastructure': [],
      'Digital Assets': [],
      'Cloud Infrastructure': [],
      'Core System': [],
      'Distributed Ledger': [],
      'Common / Library': [],
      'PoC / Verification': [],
      'Unclassified': []
    };
    
    const staleRepos = [];
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    repos.forEach(repo => {
      const name = repo.name.toLowerCase();
      const lastPush = new Date(repo.pushedAt);
      
      // Classify
      if (name.includes('project_a-') || name.includes('project_b_') || name.includes('generic_whitelabel') || name.includes('generic_banking_api')) {
        mapping['Customer Portal (CP)'].push(repo);
      } else if (name.includes('auth_sys')) {
        mapping['AuthSystem (Auth)'].push(repo);
      } else if (name.includes('service-c_') || name.includes('identity-verify')) {
        mapping['Identity Verification Solution'].push(repo);
      } else if (name.includes('identity-provider-') || name.includes('auth-logic') || name.includes('auth-server') || name.includes('secure-auth')) {
        mapping['Auth Infrastructure'].push(repo);
      } else if (name.includes('transfer-') || name.includes('digital-wallet-') || name.includes('dlt-network-') || name.includes('asset-token-')) {
        mapping['Digital Assets'].push(repo);
      } else if (name.includes('cloud-platform-') || name.includes('reliability-') || name.includes('terraform-') || name.includes('ansible-') || name.includes('infra-ops-')) {
        mapping['Cloud Infrastructure'].push(repo);
      } else if (name.includes('core_sys')) {
        mapping['Core System'].push(repo);
      } else if (name.includes('dlt-core-') || name.includes('gate-way-')) {
        mapping['Distributed Ledger'].push(repo);
      } else if (name.includes('common') || name.includes('lproject_a-') || name.includes('utils')) {
        mapping['Common / Library'].push(repo);
      } else if (name.includes('mock') || name.includes('sample') || name.includes('test') || name.includes('verif-')) {
        mapping['PoC / Verification'].push(repo);
      } else {
        mapping['Unclassified'].push(repo);
      }

      // Check Maintenance
      if (!repo.isArchived && lastPush < oneYearAgo) {
        staleRepos.push(repo);
      }
    });

    // Generate Report Output
    console.log('\n## Enhanced Audit Results Summary (v2.0)');
    for (const [category, list] of Object.entries(mapping)) {
      console.log(`- **${category}**: ${list.length} repos`);
    }
    
    console.log(`\n- **Stale Repositories (No push > 1yr)**: ${staleRepos.length} repos`);
    
    const result = { mapping, staleRepos, timestamp: new Date().toISOString() };
    fs.writeFileSync('work/github_audit_report.json', JSON.stringify(result, null, 2));
    console.log('\nDetailed report updated in work/github_audit_report.json');

  } catch (_error) {
    console.error('Error during audit:', _error.message);
    process.exit(1);
  }
}

audit();