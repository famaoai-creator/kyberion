/**
 * Doctor Core Utility
 * スキルの依存関係、権限、およびナレッジ階層の健全性をチェックするための共通ライブラリ
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const doctor = {
  /** 指定されたコマンドがインストールされているかチェック */
  checkCommand: (cmd, name) => {
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
  checkFile: (filePath, name) => {
    if (fs.existsSync(filePath)) {
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
      execSync('osascript -e "tell application \"System Events\" to get name"', {
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
   * シンボリックリンク切れや、機密情報の露出を検知する
   */
  checkKnowledgeTiers: (rootDir) => {
    console.log('\n--- Knowledge Tier Health ---');

    // 1. Confidential Symlink Check
    const confidentialPath = path.join(rootDir, 'knowledge', 'confidential');
    try {
      const stats = fs.lstatSync(confidentialPath);
      if (stats.isSymbolicLink()) {
        const target = fs.readlinkSync(confidentialPath);
        if (fs.existsSync(confidentialPath)) {
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

    // 2. Personal Tier Check
    const personalPath = path.join(rootDir, 'knowledge', 'personal');
    if (fs.existsSync(personalPath)) {
      console.log(`✅ Personal Tier: Found`);
    } else {
      console.log(`⚠️  Personal Tier: Missing (Run init_wizard.cjs)`);
    }

    // 3. Git-ignore Check (Security)
    try {
      const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
      const criticalIgnores = ['knowledge/personal/', 'knowledge/confidential/', 'work/'];
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
  checkOperationalMemory: (rootDir) => {
    console.log('\n--- Operational Memory (Active Connections) ---');
    const inventoryPath = path.join(
      rootDir,
      'knowledge',
      'confidential',
      'connections',
      'inventory.json'
    );
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

module.exports = doctor;
