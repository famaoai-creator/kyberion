import { safeReadFile, safeWriteFile } from '../libs/core/secure-io.js';
import { pathResolver } from '../libs/core/path-resolver.js';
import { TRACE_SPAN_DEFINITIONS } from '../libs/core/trace-schema.js';
import { withExecutionContext } from '../libs/core/authority.js';

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
  return `${lines.join('\n')}\n`;
}

const rendered = render();
if (process.argv.includes('--check')) {
  const current = String(safeReadFile(outputPath, { encoding: 'utf8' }) || '');
  if (current !== rendered) {
    console.error(`[generate:trace-docs] stale: ${outputPath}`);
    process.exitCode = 1;
  } else {
    console.log('[generate:trace-docs] OK');
  }
} else {
  withExecutionContext('ecosystem_architect', () =>
    safeWriteFile(outputPath, rendered, { mkdir: true, encoding: 'utf8' })
  );
  console.log(`[generate:trace-docs] wrote ${outputPath}`);
}
