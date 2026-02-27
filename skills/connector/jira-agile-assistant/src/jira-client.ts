const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class JiraClient {
  private config: any;
  private auth: string;
  private hostname: string;

  constructor(rootDir: string) {
    const configPath = path.resolve(rootDir, 'knowledge/personal/connections/jira.json');
    if (!fs.existsSync(configPath)) {
      throw new Error('Jira config not found');
    }
    this.config = JSON.parse(safeReadFile(configPath, 'utf8'));
    this.auth = Buffer.from(this.config.email + ':' + this.config.api_token).toString('base64');
    this.hostname = this.config.host.replace('https://', '');
  }

  async request(method: string, apiPath: string, body: any = null): Promise<any> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        path: apiPath,
        method: method,
        timeout: 10000,
        headers: {
          Authorization: 'Basic ' + this.auth,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : { status: 'ok' });
            } catch {
              reject(new Error('Invalid JSON response'));
            }
          } else {
            reject(new Error('Jira API Error: ' + res.statusCode + ' ' + data));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.on('error', (e) => reject(e));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async getIssue(key: string) {
    return this.request('GET', '/rest/api/3/issue/' + key);
  }

  async createIssue(fields: any) {
    return this.request('POST', '/rest/api/3/issue', { fields });
  }
}
