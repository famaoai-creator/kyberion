/**
 * Doctor Core Utility
 */
export declare const doctor: {
    /** 指定されたコマンドがインストールされているかチェック */
    checkCommand: (cmd: string, name?: string) => boolean;
    /** ファイルの存在チェック */
    checkFile: (filePath: string, name?: string) => boolean;
    /** macOSのアクセシビリティ権限チェック */
    checkAccessibility: () => boolean;
    /**
     * ナレッジ階層の整合性チェック (3-Tier Sovereign Model)
     */
    checkKnowledgeTiers: (rootDir: string) => void;
    /**
     * 過去の接続実績（インベントリ）のロードと確認
     */
    checkOperationalMemory: (rootDir: string) => void;
};
//# sourceMappingURL=doctor_core.d.ts.map