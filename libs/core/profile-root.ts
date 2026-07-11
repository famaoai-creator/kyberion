import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';

export function resolveActiveProfileRoot(): string {
  return customerResolver.customerRoot('') ?? pathResolver.knowledge('personal');
}
