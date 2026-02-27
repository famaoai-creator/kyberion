const https = require('https');
const fs = require('fs');
const path = require('path');

class JiraClient {
  constructor() {
    const configPath = path.resolve(process.cwd(), 'knowledge/personal/connections/jira.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Jira config not found at ${configPath}. Please run initialization.`);
    }
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    this.auth = Buffer.from(`${this.config.email}:${this.config.api_token}`).toString('base64');
    this.hostname = this.config.host.replace('https://', '');
  }

  async request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      console.log(`[DEBUG] Jira API Request: ${method} ${path}`);
      const options = {
        hostname: this.hostname,
        path: path,
        method: method,
        timeout: 10000, // 10 seconds timeout
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        console.log(`[DEBUG] Jira API Response received. Status: ${res.statusCode}`);
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          console.log(`[DEBUG] Jira API Request finished.`);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = data ? JSON.parse(data) : { status: 'ok' };
              resolve(parsed);
            } catch (e) {
              console.error(`[Reflex Error] JSON parse failed: ${data.substring(0, 100)}`);
              reject(new Error('Invalid JSON response from Jira'));
            }
          } else {
            console.error(`[Reflex Error] API call failed with status ${res.statusCode}`);
            reject(new Error(`Jira API Error: ${res.statusCode} ${data}`));
          }
        });
      });

      req.on('timeout', () => {
        console.error(`[DEBUG] Jira API Request timed out after 10s.`);
        req.destroy();
        reject(new Error('Jira API Request Timed Out'));
      });

      req.on('error', (e) => {
        console.error(`[Reflex Error] Connection error: ${e.message}`);
        reject(e);
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async createIssue(fields) {
    return this.request('POST', '/rest/api/3/issue', { fields });
  }

  async updateIssue(key, fields) {
    return this.request('PUT', `/rest/api/3/issue/${key}`, { fields });
  }

  async getIssue(key) {
    return this.request('GET', `/rest/api/3/issue/${key}`);
  }
}

module.exports = { JiraClient };
