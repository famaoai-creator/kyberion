/**
 * TypeScript version of skill-wrapper.
 * Provides typed wrappers for skill execution with standardized output.
 */
import type { SkillOutput } from './types.js';
export declare function wrapSkill<T>(skillName: string, fn: () => T): SkillOutput<T>;
export declare function wrapSkillAsync<T>(skillName: string, fn: () => Promise<T>): Promise<SkillOutput<T>>;
export declare function runSkill<T>(skillName: string, fn: () => T): SkillOutput<T>;
export declare function runSkillAsync<T>(skillName: string, fn: () => Promise<T>): Promise<SkillOutput<T>>;
export declare const runAsyncSkill: typeof runSkillAsync;
//# sourceMappingURL=skill-wrapper.d.ts.map