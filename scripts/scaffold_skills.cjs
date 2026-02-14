const fs = require('fs');
const path = require('path');

// Define skills and their metadata based on SKILLS_CANDIDATES.md
const skills = [
  {
    name: 'api-fetcher',
    description: 'Fetch data from REST/GraphQL APIs securely.',
    script: 'fetch.cjs',
  },
  {
    name: 'db-extractor',
    description: 'Extract schema and sample data from databases for analysis.',
    script: 'extract.cjs',
  },
  {
    name: 'audio-transcriber',
    description: 'Transcribe audio/video files to text using OpenAI Whisper.',
    script: 'transcribe.cjs',
  },
  {
    name: 'data-transformer',
    description: 'Convert between CSV, JSON, and YAML formats.',
    script: 'transform.cjs',
  },
  {
    name: 'template-renderer',
    description: 'Render text from templates (Mustache/EJS) and data.',
    script: 'render.cjs',
  },
  {
    name: 'diff-visualizer',
    description: 'Generate a visual difference report between two texts.',
    script: 'diff.cjs',
  },
  {
    name: 'word-artisan',
    description: 'Generate Word documents (.docx) from Markdown.',
    script: 'convert.cjs',
  },
  {
    name: 'pdf-composer',
    description: 'Generate PDF documents from Markdown with headers/footers.',
    script: 'compose.cjs',
  },
  {
    name: 'html-reporter',
    description: 'Generate standalone HTML reports from JSON/Markdown.',
    script: 'report.cjs',
  },
  {
    name: 'sequence-mapper',
    description: 'Generate Mermaid sequence diagrams from source code function calls.',
    script: 'map.cjs',
  },
  {
    name: 'dependency-grapher',
    description: 'Generate dependency graphs (Mermaid/DOT) from project files.',
    script: 'graph.cjs',
  },
  {
    name: 'api-doc-generator',
    description: 'Generate API documentation from OpenAPI specs or code.',
    script: 'generate.cjs',
  },
  {
    name: 'format-detector',
    description: 'Detect text format (JSON, YAML, CSV, etc.) and confidence.',
    script: 'detect.cjs',
  },
  {
    name: 'schema-validator',
    description: 'Validate JSON against schemas and identify best match.',
    script: 'validate.cjs',
  },
  {
    name: 'encoding-detector',
    description: 'Detect file encoding and line endings.',
    script: 'detect.cjs',
  },
  {
    name: 'lang-detector',
    description: 'Detect natural language of text (ja, en, etc.).',
    script: 'detect.cjs',
  },
  // Quality/Security/Classification group
  {
    name: 'sensitivity-detector',
    description: 'Detect PII and sensitive information in text.',
    script: 'scan.cjs',
  },
  {
    name: 'completeness-scorer',
    description: 'Evaluate text completeness based on criteria.',
    script: 'score.cjs',
  },
];

const rootDir = process.cwd();

console.log(`Starting bulk creation of ${skills.length} skills...`);

skills.forEach((skill) => {
  const skillDir = path.join(rootDir, skill.name);
  const scriptsDir = path.join(skillDir, 'scripts');

  // 1. Create Directories
  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
  }

  // 2. Create SKILL.md
  // Note: Using simpler string concatenation to avoid template literal issues
  const title = skill.name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  const skillMdContent = `---
name: ${skill.name}
description: ${skill.description}
---

# ${title}

${skill.description}

## Usage

\
\
node ${skill.name}/scripts/${skill.script} [options]
\
\
`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent);

  // 3. Create package.json
  const packageJsonContent = {
    name: skill.name,
    version: '0.1.0',
    description: skill.description,
    main: `scripts/${skill.script}`,
    author: 'Gemini Agent',
    license: 'ISC',
    dependencies: {},
  };
  fs.writeFileSync(
    path.join(skillDir, 'package.json'),
    JSON.stringify(packageJsonContent, null, 2)
  );

  // 4. Create Skeleton Script
  const scriptContent = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Simple skeleton for ${skill.name}
console.log("${skill.name}: ${skill.description}");

// TODO: Implement core logic
console.log("Usage: node " + path.basename(__filename) + " [args]");
`;
  fs.writeFileSync(path.join(scriptsDir, skill.script), scriptContent);
  fs.chmodSync(path.join(scriptsDir, skill.script), '755');

  console.log('✅ Created: ' + skill.name + '\n');
});

console.log('\nAll skills scaffolded successfully.');
console.log("Next steps: Install them using 'gemini skills install ...' and implement logic.");
