import type { RequestInputObject } from '../../../lib/request-input';
import {
  RequestInputError,
  optionalRequestString,
  requireRequestObject,
} from '../../../lib/request-input';

export type SetupInputObject = RequestInputObject;
export {
  RequestInputError as SetupInputError,
  optionalRequestString as optionalSetupString,
  requireRequestObject as requireSetupObject,
};

export function optionalSetupObject(
  object: SetupInputObject,
  field: string
): SetupInputObject | undefined {
  if (!(field in object)) return undefined;
  if (typeof object[field] !== 'object' || object[field] === null || Array.isArray(object[field])) {
    throw new RequestInputError(`${field} must be an object`);
  }
  return object[field] as SetupInputObject;
}

export function optionalSetupBoolean(object: SetupInputObject, field: string): boolean | undefined {
  if (!(field in object)) return undefined;
  if (typeof object[field] !== 'boolean') {
    throw new RequestInputError(`${field} must be a boolean`);
  }
  return object[field] as boolean;
}

export function optionalSetupStringArray(
  object: SetupInputObject,
  field: string
): string[] | undefined {
  if (!(field in object)) return undefined;
  if (!Array.isArray(object[field]) || object[field].some((value) => typeof value !== 'string')) {
    throw new RequestInputError(`${field} must be an array of strings`);
  }
  return [...(object[field] as string[])];
}
