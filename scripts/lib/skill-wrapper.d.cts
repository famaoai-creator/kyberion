export declare function runSkill<T>(name: string, fn: () => T): void;
export declare function runSkillAsync<T>(name: string, fn: () => Promise<T>): Promise<void>;
export declare function runAsyncSkill<T>(name: string, fn: () => Promise<T>): Promise<void>;
