const fs = require('fs');
const path = require('path');
// glob available if needed

// Mapping keywords in IaC to Non-Functional Requirement Items
const PATTERNS = [
  {
    id: 'A.2.1.1', // Server Redundancy
    keywords: ['replicas', 'desired_count', 'min_size', 'autoscaling'],
    condition: (content) => {
      const match = content.match(/(replicas|desired_count|min_size)\s*[:=]\s*(\d+)/);
      return match && parseInt(match[2]) > 1 ? '2' : null; // Level 2: Redundant
    },
  },
  {
    id: 'A.2.1.1', // Server Redundancy (Multi-AZ)
    keywords: ['multi_az', 'availability_zones'],
    condition: (content) => (content.includes('multi_az') && content.includes('true') ? '2' : null),
  },
  {
    id: 'C.1.2.6', // Backup Retention
    keywords: ['retention_period', 'retention_days'],
    condition: (content) => {
      const match = content.match(/(retention_period|retention_days)\s*[:=]\s*(\d+)/);
      if (!match) return null;
      const days = parseInt(match[2]);
      if (days >= 3650) return '4'; // 10 years
      if (days >= 1825) return '3'; // 5 years
      if (days >= 1095) return '2'; // 3 years
      if (days >= 365) return '1'; // 1 year
      return '0';
    },
  },
  {
    id: 'E.6.1.2', // Storage Encryption
    keywords: ['encrypted', 'kms_key_id', 'sse_algorithm'],
    condition: (content) => (content.includes('encrypted') || content.includes('kms') ? '2' : null),
  },
  {
    id: 'C.1.3.1', // Monitoring
    keywords: ['cloudwatch', 'datadog', 'newrelic', 'prometheus', 'alert'],
    condition: (content) => (content.toLowerCase().includes('alert') ? '2' : '1'),
  },
];

function analyzeIaC(projectRoot) {
  const findings = {};

  // Find IaC files (TF, K8s YAML, Dockerfile)
  // Note: 'glob' needs to be installed or use simple recursion.
  // For simplicity in this script without deps, we assume basic file walk or user 'find' command output?
  // Actually, let's use a simple recursive walker here to avoid external 'glob' dep if not present,
  // but we can assume 'glob' package is standard in toolkits.
  // Since we are in a 'skill', we should stick to 'fs' if possible or add 'glob' to package.json.
  // We added 'glob' to require above, so we need to ensure it's in package.json.

  // Let's use a synchronous simple walker for now to be safe and dependency-lite if 'glob' isn't there.

  const files = [];
  function walk(dir) {
    const list = fs.readdirSync(dir);
    list.forEach((file) => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        if (file !== 'node_modules' && file !== '.git') walk(filePath);
      } else {
        if (
          file.endsWith('.tf') ||
          file.endsWith('.yaml') ||
          file.endsWith('.yml') ||
          file === 'Dockerfile'
        ) {
          files.push(filePath);
        }
      }
    });
  }

  try {
    walk(projectRoot);
  } catch (_e) {
    // Ignore permission errors etc
  }

  files.forEach((file) => {
    try {
      const content = fs.readFileSync(file, 'utf8').toLowerCase();

      PATTERNS.forEach((pattern) => {
        if (pattern.keywords.some((k) => content.includes(k))) {
          const level = pattern.condition(content);
          if (level) {
            // Keep the highest detected level
            if (!findings[pattern.id] || parseInt(level) > parseInt(findings[pattern.id].level)) {
              findings[pattern.id] = {
                level: level,
                source: path.relative(projectRoot, file),
              };
            }
          }
        }
      });
    } catch (_e) {
      // Ignore read errors
    }
  });

  return findings;
}

module.exports = { analyzeIaC };
