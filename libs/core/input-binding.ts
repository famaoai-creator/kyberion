export type InputBindingType =
  | 'text'
  | 'url'
  | 'path'
  | 'date'
  | 'number'
  | 'boolean'
  | 'secret'
  | 'choice';

export interface InputBinding {
  id: string;
  type: InputBindingType;
  label: string;
  required: boolean;
}

function humanizeInputId(id: string): string {
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/\b([a-z])/g, (_, ch: string) => ch.toUpperCase())
    .trim();
}

export function classifyInputId(id: string): InputBindingType {
  const normalized = id.toLowerCase();
  if (/(^|[_-])(url|uri|link|webhook_url|callback_url|meeting_url)$/.test(normalized)) return 'url';
  if (/(^|[_-])(path|file|dir|directory|folder|artifact_path|output_path|target_path)$/.test(normalized)) return 'path';
  if (/(^|[_-])(date|time|datetime|day|range|date_range|schedule_scope)$/.test(normalized)) return 'date';
  if (/(^|[_-])(count|number|num|size|limit|timeout|quantity|amount)$/.test(normalized)) return 'number';
  if (/(^|[_-])(enabled|active|confirmed|approved|required|pending_confirmation)$/.test(normalized)) return 'boolean';
  if (/(^|[_-])(secret|token|key|password|credential)$/.test(normalized)) return 'secret';
  if (/(^|[_-])(choice|option|mode|strategy|tier|boundary)$/.test(normalized)) return 'choice';
  return 'text';
}

export function isPathInput(id: string): boolean {
  return classifyInputId(id) === 'path';
}

export function resolveInputBindings(inputIds: string[]): InputBinding[] {
  return inputIds.map((id) => ({
    id,
    type: classifyInputId(id),
    label: humanizeInputId(id),
    required: true,
  }));
}
