import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const MODEL_REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/model-registry.schema.json'
);

export type GovernedModelRegistryEntry = { model_id: string };

export type GovernedModelRegistrySnapshot<
  T extends GovernedModelRegistryEntry = GovernedModelRegistryEntry,
> = {
  version: string;
  default_model_id: string;
  models: T[];
};

let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, MODEL_REGISTRY_SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

export function validateModelRegistrySnapshot<
  T extends GovernedModelRegistryEntry = GovernedModelRegistryEntry,
>(
  value: unknown,
  label = pathResolver.knowledge('product/governance/model-registry.json')
): GovernedModelRegistrySnapshot<T> {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid model registry at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as GovernedModelRegistrySnapshot<T>;
}
