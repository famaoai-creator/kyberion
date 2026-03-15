import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { safeExistsSync, safeLstat, safeReadFile, safeReadlink } from './secure-io.js';

/**
 * Doctor Core Utility
 */
export const doctor = {
  /** 指定されたコマンドがインストールされているかチェック */
  checkCommand: (cmd: string, name?: string) => {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      console.log(`✅ ${name || cmd}: Installed`);
      return true;
    } catch (_e) {
      console.log(`❌ ${name || cmd}: Not Found`);
      return false;
    }
  },

  /** ファイルの存在チェック */
  checkFile: (filePath: string, name?: string) => {
    if (safeExistsSync(filePath)) {
      console.log(`✅ ${name || filePath}: Found`);
      return true;
    } else {
      console.log(`❌ ${name || filePath}: Missing`);
      return false;
    }
  },

  /** macOSのアクセシビリティ権限チェック */
  checkAccessibility: () => {
    if (process.platform !== 'darwin') return true;
    try {
      execSync('osascript -e "tell application "System Events" to get name"', {
        stdio: 'ignore',
      });
      console.log('✅ Accessibility: OK');
      return true;
    } catch (_e) {
      console.log('❌ Accessibility: FAILED (Required for GUI automation)');
      return false;
    }
  },

  /**
   * ナレッジ階層の整合性チェック (3-Tier Sovereign Model)
   */
  checkKnowledgeTiers: (rootDir: string) => {
    console.log('\n--- Knowledge Tier Health ---');

    const confidentialPath = path.join(rootDir, 'knowledge', 'confidential');
    try {
      const stats = safeLstat(confidentialPath);
      if (stats.isSymbolicLink()) {
        const target = safeReadlink(confidentialPath);
        if (safeExistsSync(confidentialPath)) {
          console.log(`✅ Confidential Tier: Linked to ${target}`);
        } else {
          console.log(`❌ Confidential Tier: Broken link (Target missing: ${target})`);
        }
      } else {
        console.log(`⚠️  Confidential Tier: Not a symlink (Local directory mode)`);
      }
    } catch (_e) {
      console.log(`❌ Confidential Tier: Missing (Run setup_ecosystem.sh)`);
    }

    const personalPath = path.join(rootDir, 'knowledge', 'personal');
    if (safeExistsSync(personalPath)) {
      console.log(`✅ Personal Tier: Found`);
    } else {
      console.log(`⚠️  Personal Tier: Missing (Run init_wizard.js)`);
    }

    try {
      const gitignore = safeReadFile(path.join(rootDir, '.gitignore'), { encoding: 'utf8' }) as string;
      const criticalIgnores = ['knowledge/personal/', 'knowledge/confidential/', 'active/shared/'];
      criticalIgnores.forEach((item) => {
        if (gitignore.includes(item)) {
          console.log(`✅ Security: ${item} is ignored by git`);
        } else {
          console.log(`❌ Security: ${item} is NOT in .gitignore! CRITICAL RISK.`);
        }
      });
    } catch (_e) {
      console.log(`❌ Security: .gitignore not found at root`);
    }
  },

  /**
   * 過去の接続実績（インベントリ）のロードと確認
   */
  checkOperationalMemory: (rootDir: string) => {
    console.log('\n--- Operational Memory (Active Connections) ---');
    const inventoryPath = path.join(
      rootDir,
      'knowledge',
      'confidential',
      'connections',
      'inventory.json'
    );
    if (safeExistsSync(inventoryPath)) {
      try {
        const inventory = JSON.parse(safeReadFile(inventoryPath, { encoding: 'utf8' }) as string);
        const systems = Object.keys(inventory.systems || {});
        if (systems.length > 0) {
          console.log(`✅ Known Systems: ${systems.join(', ')}`);
          systems.forEach((sys) => {
            const projects = Object.keys(inventory.systems[sys].projects || {});
            if (projects.length > 0) {
              console.log(`   - ${sys}: Found mappings for ${projects.join(', ')}`);
            }
          });
        } else {
          console.log(`⚠️  Inventory is empty.`);
        }
      } catch (_e) {
        console.log(`❌ Failed to parse connection inventory.`);
      }
    } else {
      console.log(`⚠️  No operational inventory found.`);
    }
  },
};
