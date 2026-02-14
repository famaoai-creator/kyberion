#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const knowledgeDir = path.join(rootDir, 'knowledge');

/**
 * PII Shield for Documentation
 * Scans knowledge base for accidental exposure of credentials or PII.
 */

const FORBIDDEN_PATTERNS = [
  { name: 'API_KEY', regex: /AIza[0-9A-Za-z-_]{35}/ },
  { name: 'OAUTH_SECRET', regex: /[0-9A-Za-z-_]{24,32}\.apps\.googleusercontent\.com/ },
  { name: 'PRIVATE_KEY', regex: /-----BEGIN PRIVATE KEY-----/ },
  { name: 'GENERIC_SECRET', regex: /secret[:=]\s*['"][0-9A-Za-z-_]{16,}['"]/i },
];

function scanDocs() {

  const violations = [];

  const personalDir = path.join(knowledgeDir, 'personal');

  

  function walk(dir) {

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {

      const p = path.join(dir, entry.name);

      

      // Security: Skip personal tier from scanning (intended secrets)

      if (p.startsWith(personalDir)) continue;



      if (entry.isDirectory()) walk(p);

      else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {


        const content = fs.readFileSync(p, 'utf8');
        FORBIDDEN_PATTERNS.forEach((pattern) => {
          if (pattern.regex.test(content)) {
            violations.push({ file: path.relative(rootDir, p), type: pattern.name });
          }
        });
      }
    }
  }

  walk(knowledgeDir);
  return violations;
}

const violations = scanDocs();
if (violations.length > 0) {
  console.log(`
\ud83d\udea8  SECURITY ALERT: Forbidden tokens detected in Knowledge Base!
`);
  violations.forEach((v) => console.log(`  [${v.type}] ${v.file}`));
  process.exit(1);
} else {
  console.log('✅ Documentation safety verified. No sensitive tokens found.');
}
