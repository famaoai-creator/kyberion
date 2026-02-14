#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('role', {
    alias: 'r',
    type: 'string',
    default: 'engineer',
    choices: ['engineer', 'senior-engineer', 'tech-lead', 'devops', 'qa'],
    description: 'Role type',
  })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function detectTechStack(dir) {
  const stack = { languages: [], frameworks: [], tools: [] };
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const deps = Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies || {});
      stack.languages.push('JavaScript/TypeScript');
      if (deps.includes('react') || deps.includes('next')) stack.frameworks.push('React');
      if (deps.includes('express') || deps.includes('fastify'))
        stack.frameworks.push('Node.js backend');
      if (deps.includes('prisma') || deps.includes('sequelize')) stack.tools.push('ORM');
    } catch (_e) {}
  }
  if (
    fs.existsSync(path.join(dir, 'requirements.txt')) ||
    fs.existsSync(path.join(dir, 'pyproject.toml'))
  )
    stack.languages.push('Python');
  if (fs.existsSync(path.join(dir, 'go.mod'))) stack.languages.push('Go');
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) stack.languages.push('Rust');
  if (fs.existsSync(path.join(dir, '.github/workflows'))) stack.tools.push('GitHub Actions');
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) stack.tools.push('Docker');
  if (fs.existsSync(path.join(dir, 'terraform'))) stack.tools.push('Terraform');
  return stack;
}

function generateJobDescription(role, stack) {
  const titles = {
    engineer: 'Software Engineer',
    'senior-engineer': 'Senior Software Engineer',
    'tech-lead': 'Technical Lead',
    devops: 'DevOps Engineer',
    qa: 'QA Engineer',
  };
  const requirements = {
    engineer: {
      experience: '2-4 years',
      skills: [...stack.languages, ...stack.frameworks, 'Git', 'Testing'],
      nice: ['CI/CD', 'Cloud services'],
    },
    'senior-engineer': {
      experience: '5-8 years',
      skills: [...stack.languages, ...stack.frameworks, 'System Design', 'Mentoring'],
      nice: ['Architecture', 'Performance optimization'],
    },
    'tech-lead': {
      experience: '7+ years',
      skills: [
        ...stack.languages,
        'Architecture',
        'Team leadership',
        'Code review',
        'Project planning',
      ],
      nice: ['Cross-team coordination'],
    },
    devops: {
      experience: '3-5 years',
      skills: [...stack.tools, 'Linux', 'Monitoring', 'IaC', 'CI/CD'],
      nice: ['Kubernetes', 'AWS/GCP/Azure'],
    },
    qa: {
      experience: '2-4 years',
      skills: ['Test automation', 'API testing', ...stack.languages.slice(0, 1), 'Bug tracking'],
      nice: ['Performance testing', 'Security testing'],
    },
  };
  return { title: titles[role], ...requirements[role], techStack: stack };
}

runSkill('talent-requirement-generator', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const stack = detectTechStack(targetDir);
  const jd = generateJobDescription(argv.role, stack);
  const result = {
    directory: targetDir,
    role: argv.role,
    detectedTechStack: stack,
    jobDescription: jd,
    recommendations: [
      `Generated ${jd.title} JD based on detected tech stack`,
      stack.languages.length === 0
        ? 'Could not detect languages - provide more context'
        : `Key skills: ${jd.skills.join(', ')}`,
    ],
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
