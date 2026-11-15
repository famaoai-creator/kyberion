import * as path from 'node:path';
import { safeReadFileSnapshot, safeRealpath } from '@agent/core/secure-io';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { pathResolver } from '@agent/core/path-resolver';
import {
  parseContinuousOperationsConfig,
  type ContinuousOperationsConfig,
} from '@agent/core/organization/continuous-operations-policy';

export const CONTINUOUS_CONFIG_ROOT = 'knowledge/product/governance/continuous-operations/';
/** Only reviewed product configuration can select a source or an executable action. */
export function loadContinuousOperationsConfig(
  ref: unknown,
  deps: {
    realpath?: (file: string) => string;
    read?: (file: string) => unknown;
    rootDir?: string;
  } = {}
): ContinuousOperationsConfig {
  if (
    typeof ref !== 'string' ||
    !ref.startsWith(CONTINUOUS_CONFIG_ROOT) ||
    !/^[A-Za-z0-9_./-]+\.json$/.test(ref) ||
    ref.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(
      'Continuous operations config must be a reviewed JSON file under ' + CONTINUOUS_CONFIG_ROOT
    );
  }
  const root = deps.rootDir ?? pathResolver.rootDir();
  const expected = path.resolve(root, ref);
  const actual = (deps.realpath ?? safeRealpath)(expected);
  // No symlink aliases: a trusted config path must not resolve to an externally writable file.
  if (actual !== expected) throw new Error('Continuous operations config cannot be a symlink');
  const raw = deps.read
    ? deps.read(actual)
    : parseSafeJsonInput(
        safeReadFileSnapshot(actual, 1_048_576).toString('utf8'),
        'continuous operations config'
      );
  return parseContinuousOperationsConfig(raw);
}
