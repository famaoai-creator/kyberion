import fs from 'fs';
import path from 'path';
import {
  TechStackInfo,
  StrategicAction,
  DocumentArtifact,
} from '@agent/core/shared-business-types';

export type RoleType = 'engineer' | 'senior-engineer' | 'tech-lead' | 'devops' | 'qa';

/**
 * Job description extending shared DocumentArtifact.
 */
export interface JobDescription extends DocumentArtifact {
  experience: string;
  skills: string[];
  nice: string[];
  techStack: TechStackInfo;
}

export interface TalentResult {
  directory: string;
  role: RoleType;
  detectedTechStack: TechStackInfo;
  jobDescription: JobDescription;
  recommendations: StrategicAction[];
}

export function detectTechStack(dir: string): TechStackInfo {
  const stack: TechStackInfo = { languages: [], frameworks: [], tools: [] };
  const pkgPath = path.join(dir, 'package.json');

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = Object.keys(pkg.dependencies || {});
      stack.languages.push('JavaScript/TypeScript');
      if (deps.includes('react') || deps.includes('next')) stack.frameworks.push('React');
      if (deps.includes('express') || deps.includes('fastify'))
        stack.frameworks.push('Node.js backend');
      if (deps.includes('prisma') || deps.includes('sequelize')) stack.tools.push('ORM');
    } catch (_e) {
      /* ignore */
    }
  }

  if (
    fs.existsSync(path.join(dir, 'requirements.txt')) ||
    fs.existsSync(path.join(dir, 'pyproject.toml'))
  ) {
    stack.languages.push('Python');
  }
  if (fs.existsSync(path.join(dir, 'go.mod'))) stack.languages.push('Go');
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) stack.languages.push('Rust');

  if (fs.existsSync(path.join(dir, '.github/workflows'))) stack.tools.push('GitHub Actions');
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) stack.tools.push('Docker');
  if (fs.existsSync(path.join(dir, 'terraform'))) stack.tools.push('Terraform');

  return stack;
}

export function generateJobDescription(role: string, stack: TechStackInfo): JobDescription {
  const titles: Record<string, string> = {
    engineer: 'Software Engineer',
    'senior-engineer': 'Senior Software Engineer',
    'tech-lead': 'Technical Lead',
    devops: 'DevOps Engineer',
    qa: 'QA Engineer',
    default: 'Software Development Professional',
  };

  const requirements: Record<string, { experience: string; skills: string[]; nice: string[] }> = {
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
    default: {
      experience: '3+ years',
      skills: [...stack.languages, 'Problem solving', 'Agile methodology'],
      nice: [...stack.frameworks, ...stack.tools],
    },
  };

  const req = requirements[role] || requirements.default;
  const title = titles[role] || titles.default;

  const body = `
# ${title}
## Requirements
- Experience: ${req.experience}
- Skills: ${req.skills.join(', ')}
## Preferred
- ${req.nice.join(', ')}
  `.trim();

  return {
    title,
    body,
    format: 'markdown',
    ...req,
    techStack: stack,
  };
}

export function processTalentRequirements(dir: string, role: string): TalentResult {
  const stack = detectTechStack(dir);
  const jd = generateJobDescription(role, stack);

  return {
    directory: dir,
    role: role as RoleType,
    detectedTechStack: stack,
    jobDescription: jd,
    recommendations: [
      {
        action: `Finalize and post ${jd.title} job description`,
        priority: 'high',
        area: 'Hiring',
      },
      {
        action:
          stack.languages.length === 0
            ? 'Manually verify tech stack - auto-detection failed'
            : `Search for candidates with ${stack.languages[0]} expertise`,
        priority: stack.languages.length === 0 ? 'medium' : 'low',
        area: 'Recruitment',
      },
    ],
  };
}
