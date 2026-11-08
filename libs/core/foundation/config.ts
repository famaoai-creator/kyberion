/**
 * Typed runtime settings facade over the env registry.
 *
 * Values still resolve through {@link getRegisteredEnv} / secure-io's registry
 * reader — this module adds compile-time names and value types generated from
 * `env-registry.json`. It does not read files, talk to storage-backend, or own
 * durable catalog / config-mission mutation flows.
 */

import type { RegisteredEnvName, RegisteredEnvValueByName } from './config.generated.js';
import {
  getRegisteredEnv,
  getRegisteredEnvBool,
  getRegisteredEnvText,
  setRegisteredEnv,
} from './env.js';

export type { RegisteredEnvName, RegisteredEnvValueByName };

export type BooleanRegisteredEnvName = {
  [Name in RegisteredEnvName]: RegisteredEnvValueByName[Name] extends boolean ? Name : never;
}[RegisteredEnvName];

export type NumberRegisteredEnvName = {
  [Name in RegisteredEnvName]: RegisteredEnvValueByName[Name] extends number ? Name : never;
}[RegisteredEnvName];

export type TextRegisteredEnvName = {
  [Name in RegisteredEnvName]: RegisteredEnvValueByName[Name] extends string ? Name : never;
}[RegisteredEnvName];

export interface ConfigReadOptions<Name extends RegisteredEnvName> {
  env?: Record<string, string | undefined>;
  strict?: boolean;
  preserveEmpty?: boolean;
  defaultValue?: RegisteredEnvValueByName[Name];
}

function configGet<Name extends RegisteredEnvName>(
  name: Name,
  options: ConfigReadOptions<Name> = {}
): RegisteredEnvValueByName[Name] | undefined {
  return getRegisteredEnv(name, options) as RegisteredEnvValueByName[Name] | undefined;
}

function configText<Name extends RegisteredEnvName>(
  name: Name,
  options: Omit<ConfigReadOptions<Name>, 'defaultValue'> = {}
): string | undefined {
  return getRegisteredEnvText(name, options);
}

function configBool(
  name: BooleanRegisteredEnvName,
  options: {
    env?: Record<string, string | undefined>;
    strict?: boolean;
    defaultValue?: boolean;
  } = {}
): boolean | undefined {
  return getRegisteredEnvBool(name, options);
}

function configSet(
  name: RegisteredEnvName,
  value: string | undefined,
  env: Record<string, string | undefined> = process.env
): void {
  setRegisteredEnv(name, value, env);
}

/**
 * Preferred settings surface for feature code.
 *
 * Prefer `config.get` / `config.text` / `config.bool` over `process.env.KYBERION_*`.
 * Foundation bootstrap and cycle-sensitive paths may still use `process-env.ts`.
 */
export const config = {
  get: configGet,
  text: configText,
  bool: configBool,
  set: configSet,
} as const;
