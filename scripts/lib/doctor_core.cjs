/**
 * Doctor Core Utility
 * スキルの依存関係や権限をチェックするための共通ライブラリ
 */
const { execSync } = require('child_process');
const fs = require('fs');

const doctor = {
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
  
  checkFile: (path, name) => {
    if (fs.existsSync(path)) {
      console.log(`✅ ${name || path}: Found`);
      return true;
    } else {
      console.log(`❌ ${name || path}: Missing`);
      return false;
    }
  },

  checkAccessibility: () => {
    try {
      execSync('osascript -e "tell application \"System Events\" to get name"', { stdio: 'ignore' });
      console.log('✅ Accessibility: OK');
      return true;
    } catch (_e) {
      console.log('❌ Accessibility: FAILED');
      return false;
    }
  }
};

module.exports = doctor;
