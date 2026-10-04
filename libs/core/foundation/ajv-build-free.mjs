import Ajv from 'ajv';

/** Build-free schema compiler for entry points that cannot load core dist. */
export function compileBuildFreeSchema(schema) {
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}
