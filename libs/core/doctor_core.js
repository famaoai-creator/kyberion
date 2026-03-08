"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.doctor = void 0;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Doctor Core Utility
 */
exports.doctor = {
    /** 指定されたコマンドがインストールされているかチェック */
    checkCommand: (cmd, name) => {
        try {
            (0, node_child_process_1.execSync)(`${cmd} --version`, { stdio: 'ignore' });
            console.log(`✅ ${name || cmd}: Installed`);
            return true;
        }
        catch (_e) {
            console.log(`❌ ${name || cmd}: Not Found`);
            return false;
        }
    },
    /** ファイルの存在チェック */
    checkFile: (filePath, name) => {
        if (fs.existsSync(filePath)) {
            console.log(`✅ ${name || filePath}: Found`);
            return true;
        }
        else {
            console.log(`❌ ${name || filePath}: Missing`);
            return false;
        }
    },
    /** macOSのアクセシビリティ権限チェック */
    checkAccessibility: () => {
        if (process.platform !== 'darwin')
            return true;
        try {
            (0, node_child_process_1.execSync)('osascript -e "tell application "System Events" to get name"', {
                stdio: 'ignore',
            });
            console.log('✅ Accessibility: OK');
            return true;
        }
        catch (_e) {
            console.log('❌ Accessibility: FAILED (Required for GUI automation)');
            return false;
        }
    },
    /**
     * ナレッジ階層の整合性チェック (3-Tier Sovereign Model)
     */
    checkKnowledgeTiers: (rootDir) => {
        console.log('\n--- Knowledge Tier Health ---');
        const confidentialPath = path.join(rootDir, 'knowledge', 'confidential');
        try {
            const stats = fs.lstatSync(confidentialPath);
            if (stats.isSymbolicLink()) {
                const target = fs.readlinkSync(confidentialPath);
                if (fs.existsSync(confidentialPath)) {
                    console.log(`✅ Confidential Tier: Linked to ${target}`);
                }
                else {
                    console.log(`❌ Confidential Tier: Broken link (Target missing: ${target})`);
                }
            }
            else {
                console.log(`⚠️  Confidential Tier: Not a symlink (Local directory mode)`);
            }
        }
        catch (_e) {
            console.log(`❌ Confidential Tier: Missing (Run setup_ecosystem.sh)`);
        }
        const personalPath = path.join(rootDir, 'knowledge', 'personal');
        if (fs.existsSync(personalPath)) {
            console.log(`✅ Personal Tier: Found`);
        }
        else {
            console.log(`⚠️  Personal Tier: Missing (Run init_wizard.js)`);
        }
        try {
            const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
            const criticalIgnores = ['knowledge/personal/', 'knowledge/confidential/', 'active/shared/'];
            criticalIgnores.forEach((item) => {
                if (gitignore.includes(item)) {
                    console.log(`✅ Security: ${item} is ignored by git`);
                }
                else {
                    console.log(`❌ Security: ${item} is NOT in .gitignore! CRITICAL RISK.`);
                }
            });
        }
        catch (_e) {
            console.log(`❌ Security: .gitignore not found at root`);
        }
    },
    /**
     * 過去の接続実績（インベントリ）のロードと確認
     */
    checkOperationalMemory: (rootDir) => {
        console.log('\n--- Operational Memory (Active Connections) ---');
        const inventoryPath = path.join(rootDir, 'knowledge', 'confidential', 'connections', 'inventory.json');
        if (fs.existsSync(inventoryPath)) {
            try {
                const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
                const systems = Object.keys(inventory.systems || {});
                if (systems.length > 0) {
                    console.log(`✅ Known Systems: ${systems.join(', ')}`);
                    systems.forEach((sys) => {
                        const projects = Object.keys(inventory.systems[sys].projects || {});
                        if (projects.length > 0) {
                            console.log(`   - ${sys}: Found mappings for ${projects.join(', ')}`);
                        }
                    });
                }
                else {
                    console.log(`⚠️  Inventory is empty.`);
                }
            }
            catch (_e) {
                console.log(`❌ Failed to parse connection inventory.`);
            }
        }
        else {
            console.log(`⚠️  No operational inventory found.`);
        }
    },
};
//# sourceMappingURL=doctor_core.js.map