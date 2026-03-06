/**
 * TypeScript version of skill-wrapper.
 * Provides typed wrappers for skill execution with standardized output.
 *
 * DESIGN NOTE: Library functions (wrapSkill, wrapSkillAsync, runSkill,
 * runSkillAsync) never call process.exit(). That decision belongs to CLI
 * entrypoints. Use runSkillCli() for the traditional "print + exit" behaviour.
 */
import type { SkillOutput } from './types.js';
export declare function wrapSkill<T>(skillName: string, fn: () => T): SkillOutput<T>;
export declare function wrapSkillAsync<T>(skillName: string, fn: () => Promise<T>): Promise<SkillOutput<T>>;
/**
 * Run a skill and print its output. Returns the output regardless of status.
 * Does NOT call process.exit — use runSkillCli for CLI entrypoints.
 */
export declare function runSkill<T>(skillName: string, fn: () => T): SkillOutput<T>;
/**
 * Async variant of runSkill.
 */
export declare function runSkillAsync<T>(skillName: string, fn: () => Promise<T>): Promise<SkillOutput<T>>;
/**
 * CLI entrypoint wrapper: runs the skill, prints output, and exits with
 * code 1 on error. Use this only in top-level CLI scripts, never in library
 * code that may be imported by tests or other skills.
 */
export declare function runSkillCli<T>(skillName: string, fn: () => T): void;
export declare function runSkillAsyncCli<T>(skillName: string, fn: () => Promise<T>): Promise<void>;
export declare const runAsyncSkill: typeof runSkillAsync;
//# sourceMappingURL=skill-wrapper.d.ts.map