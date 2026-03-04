/**
 * Operational Runbook Generator Core Library.
 */

export interface IncidentType {
  name: string;
  steps: string[];
}

export function generateRunbookMarkdown(incident: IncidentType): string {
  let rb = `# Operational Runbook: \${incident.name}\n\n`;
  rb += `## 🛠 Response Steps\n`;
  incident.steps.forEach((step, idx) => {
    rb += `\${idx + 1}. \${step}\n`;
  });
  return rb.trim();
}

export const generateRunbook = generateRunbookMarkdown;

export const TEMPLATES: Record<string, IncidentType> = {
  db_outage: {
    name: 'Database Connection Failure',
    steps: ['Check network', 'Check credentials', 'Restart service']
  },
  high_latency: {
    name: 'High Latency Detected',
    steps: ['Check resource usage', 'Check logs for slow queries', 'Scale up if needed']
  }
};
