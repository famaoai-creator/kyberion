const crypto = require('crypto');
const _fs = require('fs');
const _path = require('path');

/**
 * Pulse Guard: Sovereign Token Manager
 * Ensures that background agents operate within a strictly defined scope.
 */
const pulseGuard = {
  /**
   * Create a scoped execution token
   * @param {string} missionId - MSN-XXXX
   * @param {Object} scope - { allowedDirs: [], allowedSkills: [] }
   */
  createToken: (missionId, scope) => {
    const secret = process.env.GEMINI_SOVEREIGN_SECRET || 'default-secret';
    const payload = JSON.stringify({ missionId, scope, ts: Date.now() });
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return Buffer.from(payload).toString('base64') + '.' + hmac;
  },

  /**
   * Validate and parse a token
   */
  validateToken: (token) => {
    try {
      const [base64Payload, signature] = token.split('.');
      const secret = process.env.GEMINI_SOVEREIGN_SECRET || 'default-secret';
      const payload = Buffer.from(base64Payload, 'base64').toString();
      
      const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      if (signature !== expectedHmac) return null;

      const data = JSON.parse(payload);
      // トークンの有効期限 (例: 1時間)
      if (Date.now() - data.ts > 3600000) return null;

      return data;
    } catch (_e) {
      return null;
    }
  }
};

module.exports = pulseGuard;
