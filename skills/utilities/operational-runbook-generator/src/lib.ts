export const TEMPLATES: any = {
  deploy: {
    overview: (service: string) => 'Standard deployment procedure for **' + service + '**.',
    steps: ['Pull release tag', 'Pre-deployment checks', 'Deploy', 'Smoke tests'],
  },
  rollback: {
    overview: (service: string) => 'Emergency rollback procedure for **' + service + '**.',
    steps: ['Identify version', 'Trigger rollback', 'Verify health'],
  },
};

export function generateRunbookMarkdown(service: string, type: string, template: any): string {
  let md = '# ' + type.toUpperCase() + ' Runbook: ' + service + '\\n\\n';
  md += '> Generated on ' + new Date().toISOString().split('T')[0] + '\\n\\n';
  md += '## Overview\\n\\n' + template.overview(service) + '\\n\\n';
  md += '## Steps\\n\\n';
  template.steps.forEach((step: string, i: number) => {
    md += i + 1 + '. ' + step + '\\n';
  });
  return md;
}
