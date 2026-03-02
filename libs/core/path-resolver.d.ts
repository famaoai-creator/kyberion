export function rootDir(): string;
export function activeRoot(): string;
export function skillDir(skillName: string): string;
export function missionDir(missionId: string): string;
export function shared(subPath?: string): string;
export function resolve(logicalPath: string): string;
export function isProtected(filePath: string): boolean;
