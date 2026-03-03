export declare function rootDir(): string;
export declare function knowledge(subPath?: string): string;
export declare function active(subPath?: string): string;
export declare function scripts(subPath?: string): string;
export declare function vault(subPath?: string): string;
export declare function shared(subPath?: string): string;
export declare function isProtected(filePath: string): boolean;
export declare function skillDir(skillName: string): string;
export declare function missionDir(missionId: string): string;
export declare function resolve(logicalPath: string): string;
export declare function rootResolve(relativePath: string): string;
export declare const pathResolver: {
    rootDir: () => string;
    activeRoot: () => string;
    knowledgeRoot: () => string;
    scriptsRoot: () => string;
    vaultRoot: () => string;
    knowledge: typeof knowledge;
    active: typeof active;
    scripts: typeof scripts;
    vault: typeof vault;
    shared: typeof shared;
    isProtected: typeof isProtected;
    skillDir: typeof skillDir;
    missionDir: typeof missionDir;
    resolve: typeof resolve;
    rootResolve: typeof rootResolve;
};
//# sourceMappingURL=path-resolver.d.ts.map