export interface IncidentInput {
  id?: string;
  title?: string;
  summary?: string;
  detail?: string;
  labels?: string[];
}

export interface IncidentRecord {
  id: string;
  title: string;
  summary: string;
  detail: string;
  labels: string[];
}

export function distillIncident(input: IncidentInput): IncidentRecord {
  return {
    id: input.id || `incident-${Date.now()}`,
    title: input.title || 'Incident',
    summary: input.summary || '',
    detail: input.detail || '',
    labels: Array.isArray(input.labels) ? input.labels.filter(Boolean) : [],
  };
}

export function summarizeIncidents(records: IncidentRecord[]): string {
  if (!records.length) return '';
  return records.map((record) => `${record.title}: ${record.summary}`.trim()).join('\n');
}
