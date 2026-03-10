export declare function rootDir(): string;
export declare function knowledge(subPath?: string): string;
export declare function active(subPath?: string): string;
export declare function scripts(subPath?: string): string;
export declare function vault(subPath?: string): string;
export declare function vision(subPath?: string): string;
export declare function shared(subPath?: string): string;
export declare function isProtected(filePath: string): boolean;
export declare function skillDir(skillName: string): string;
export declare function missionDir(missionId: string, tier?: 'personal' | 'confidential' | 'public'): string;
/**
 * Returns the path to the evidence directory for a given mission.
 */
export declare function missionEvidenceDir(missionId: string): string;
/**
 * Searches for a mission directory across all available tiers.
 * Priority: personal -> confidential -> public
 */
export declare function findMissionPath(missionId: string): string | null;
export declare function resolve(logicalPath: string): string;
export declare function rootResolve(relativePath: string): string;
export declare const pathResolver: {
    rootDir: () => string;
    activeRoot: () => string;
    knowledgeRoot: () => string;
    scriptsRoot: () => string;
    vaultRoot: () => string;
    visionRoot: () => string;
    knowledge: typeof knowledge;
    active: typeof active;
    scripts: typeof scripts;
    vault: typeof vault;
    vision: typeof vision;
    shared: typeof shared;
    isProtected: typeof isProtected;
    skillDir: typeof skillDir;
    missionDir: typeof missionDir;
    missionEvidenceDir: typeof missionEvidenceDir;
    findMissionPath: typeof findMissionPath;
    resolve: typeof resolve;
    rootResolve: typeof rootResolve;
};
//# sourceMappingURL=path-resolver.d.ts.map