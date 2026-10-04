import { defineCatalog } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';

export interface IngestDocumentParserInput {
  format: string;
  bytes: Buffer;
  source_path?: string;
  ocr?: boolean;
}

export interface IngestDocumentParserResult {
  markdown: string;
  title?: string;
  tables?: Array<{ name?: string; markdown: string }>;
}

interface IngestDocumentParserModuleEntry {
  format: string;
  module: string;
}

interface IngestDocumentParserModuleCatalog {
  version: string;
  parsers: IngestDocumentParserModuleEntry[];
}

interface IngestDocumentParserModule {
  parseIngestDocument?: (
    input: IngestDocumentParserInput
  ) => Promise<IngestDocumentParserResult> | IngestDocumentParserResult;
}

const parserCatalog = defineCatalog<IngestDocumentParserModuleCatalog>({
  id: 'ingest-document-parser-modules',
  path: pathResolver.knowledge('product/governance/ingest-document-parser-modules.json'),
  schema: pathResolver.knowledge('product/schemas/ingest-document-parser-modules.schema.json'),
});

export async function parseWithRegisteredDocumentParser(
  input: IngestDocumentParserInput
): Promise<IngestDocumentParserResult | undefined> {
  const matchingParsers = parserCatalog
    .load()
    .parsers.filter((entry) => entry.format === input.format);
  if (matchingParsers.length > 1) {
    throw new Error(
      '[ingest:parse_document] multiple parser modules are registered for format ' + input.format
    );
  }
  const descriptor = matchingParsers[0];
  if (!descriptor) return undefined;
  const parserModule = (await import(descriptor.module)) as IngestDocumentParserModule;
  if (typeof parserModule.parseIngestDocument !== 'function') {
    throw new Error(
      '[ingest:parse_document] parser module ' +
        descriptor.module +
        ' must export parseIngestDocument(input)'
    );
  }
  const result = await parserModule.parseIngestDocument(input);
  if (!result || typeof result.markdown !== 'string') {
    throw new Error(
      '[ingest:parse_document] parser ' + descriptor.format + ' must return markdown'
    );
  }
  if (result.title !== undefined && typeof result.title !== 'string') {
    throw new Error(
      '[ingest:parse_document] parser ' + descriptor.format + ' returned an invalid title'
    );
  }
  if (
    result.tables !== undefined &&
    (!Array.isArray(result.tables) ||
      result.tables.some((table) => !table || typeof table.markdown !== 'string'))
  ) {
    throw new Error(
      '[ingest:parse_document] parser ' + descriptor.format + ' returned invalid tables'
    );
  }
  return result;
}
