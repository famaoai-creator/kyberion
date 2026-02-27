export interface Repo {
  name: string;
  description: string;
  pushedAt: string;
  isArchived: boolean;
  hasIssues: boolean;
  hasWiki: boolean;
  defaultBranch: string;
}

export interface AuditResult {
  score: number;
  warnings: string[];
}

export function auditRepoHygiene(repo: Repo): AuditResult {
  const warnings: string[] = [];
  let score = 100;

  if (!repo.description) {
    warnings.push('Missing repository description.');
    score -= 10;
  }
  if (!repo.hasIssues) {
    warnings.push('Issues are disabled. Recommended for active development.');
    score -= 5;
  }
  if (repo.defaultBranch !== 'main') {
    warnings.push(`Legacy default branch name detected: ${repo.defaultBranch}. Consider renaming to 'main'.`);
    score -= 5;
  }
  if (repo.isArchived) {
    warnings.push('Repository is archived. No further commits expected.');
  }

  return { score, warnings };
}

export function classifyRepos(repos: Repo[]): Record<string, any[]> {
  const mapping: Record<string, any[]> = {
    'Customer Portal (CP)': [],
    'AuthSystem (Auth)': [],
    'Common / Library': [],
    'PoC / Verification': [],
    Unclassified: [],
  };

  repos.forEach((repo) => {
    const audit = auditRepoHygiene(repo);
    const name = repo.name.toLowerCase();
    const entry = { ...repo, audit };

    if (name.includes('project_a-') || name.includes('project_b_')) {
      mapping['Customer Portal (CP)'].push(entry);
    } else if (name.includes('auth_sys')) {
      mapping['AuthSystem (Auth)'].push(entry);
    } else if (name.includes('common') || name.includes('lproject_a-')) {
      mapping['Common / Library'].push(entry);
    } else if (name.includes('mock') || name.includes('sample')) {
      mapping['PoC / Verification'].push(entry);
    } else {
      mapping['Unclassified'].push(entry);
    }
  });

  return mapping;
}
