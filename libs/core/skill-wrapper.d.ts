/**
 * libs/core/skill-wrapper.ts
 * Provides typed wrappers for capability execution with standardized output.
 * [SECURE-IO COMPLIANT VERSION]
 */
import type { SkillOutput } from './types.js';
export declare function wrapSkill<T>(skillName: string, fn: () => T): SkillOutput<T>;
export declare function wrapSkillAsync<T>(skillName: string, fn: () => Promise<T>): Promise<SkillOutput<T>>;
export declare function runSkill<T>(skillName: string, fn: () => T): SkillOutput<T>;
export declare function runSkillAsync<T>(skillName: string, fn: () => Promise<T>): Promise<SkillOutput<T>>;
export declare function runSkillCli<T>(skillName: string, fn: () => T): void;
export declare function runSkillAsyncCli<T>(skillName: string, fn: () => Promise<T>): Promise<void>;
export declare const runAsyncSkill: typeof runSkillAsync;
//# sourceMappingURL=skill-wrapper.d.ts.map