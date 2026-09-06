import { pathResolver } from '@agent/core/path-resolver';
import {
  TRACE_EXTENSION_SPAN_NAMES,
  TRACE_EXTENSION_SPAN_PREFIXES,
  TRACE_SPAN_DEFINITIONS,
} from '@agent/core/trace-schema';
import { defineGenerator, isDirectScript } from './lib/harness.js';

const outputPath = pathResolver.rootResolve('docs/developer/TRACE_SCHEMA.md');

function render(): string {
  const lines = [
    '# Kyberion Trace Schema',
    '',
    '> Generated from `libs/core/trace-schema.ts`; edit the schema source, not this file.',
    '',
    '| Span kind | Allowed parents | Status error condition |',
    '| --- | --- | --- |',
  ];
  for (const definition of Object.values(TRACE_SPAN_DEFINITIONS)) {
    lines.push(
      `| ${definition.name} | ${definition.parents.join(', ') || '(root)'} | ${definition.status.errorWhen || '(none)'} |`
    );
  }
  lines.push('');
  for (const definition of Object.values(TRACE_SPAN_DEFINITIONS)) {
    lines.push(`## ${definition.name}`, '', definition.description, '');
    lines.push(
      '### Attributes',
      '',
      '| Phase | Name | Type | Cardinality | Sensitive | Description |',
      '| --- | --- | --- | --- | --- | --- |'
    );
    for (const [phase, attributes] of [
      ['start', definition.startAttributes],
      ['end', definition.endAttributes],
    ] as const) {
      for (const [name, attribute] of Object.entries(attributes)) {
        lines.push(
          `| ${phase} | ${name} | ${attribute.type} | ${attribute.cardinality} | ${attribute.sensitive ? 'yes' : 'no'} | ${attribute.description} |`
        );
      }
    }
    lines.push('', '### Events', '', '| Event | Description |', '| --- | --- |');
    for (const [name, event] of Object.entries(definition.events)) {
      lines.push(`| ${name} | ${event.description} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Extension replay vocabulary',
    '',
    'Strict replay consumers accept these explicitly governed extension names and dynamic namespaces.',
    '',
    `- Exact names: ${TRACE_EXTENSION_SPAN_NAMES.map((name) => `\`${name}\``).join(', ')}`,
    `- Dynamic namespaces: ${TRACE_EXTENSION_SPAN_PREFIXES.map((prefix) => `\`${prefix}\``).join(', ')}`,
    ''
  );
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

export const runGenerateTraceDocs = defineGenerator({
  id: 'trace-docs',
  outputs: [outputPath],
  render: () => [{ path: outputPath, content: render() }],
});

if (
  isDirectScript(import.meta.url, 'generate_trace_docs.ts') ||
  isDirectScript(import.meta.url, 'generate_trace_docs.js')
)
  void runGenerateTraceDocs();
