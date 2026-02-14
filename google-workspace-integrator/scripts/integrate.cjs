#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const pathResolver = require('../../scripts/lib/path-resolver.cjs');
const { google } = require('googleapis');
const { runSkillAsync } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const rootDir = path.resolve(__dirname, '../..');

const argv = createStandardYargs()
  .option('action', {
    alias: 'a',
    type: 'string',
    default: 'status',
    choices: ['status', 'draft-email', 'draft-doc', 'sheet-data', 'list-events', 'auth-login'],
    description: 'Action to perform',
  })
  .option('input', { alias: 'i', type: 'string', description: 'Input data file (JSON)' })
  .option('to', { alias: 't', type: 'string', description: 'Email recipient' })
  .option('dry-run', { type: 'boolean', default: true, describe: 'Simulate without API calls' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function checkAuth() {
  const paths = [
    'knowledge/personal/connections/google/google-credentials.json',
    'knowledge/personal/google-credentials.json',
    'credentials.json',
  ];
  for (const p of paths) {
    const resolved = path.resolve(rootDir, p);
    if (fs.existsSync(resolved)) return { configured: true, path: resolved };
  }
  return { configured: false, path: null };
}

async function getAuthenticatedClient() {
  const authStatus = checkAuth();

  // 1. Check local JSON file (Highest priority)
  if (authStatus.configured) {
    const content = fs.readFileSync(authStatus.path, 'utf8');
    const credentials = JSON.parse(content);

    // 1a. Service Account
    if (credentials.client_email) {
      return google.auth.fromJSON(credentials);
    }

    // 1b. OAuth2 Client ID
    const key = credentials.installed || credentials.web;
    if (key) {
      const oauth2Client = new google.auth.OAuth2(
        key.client_id,
        key.client_secret,
        key.redirect_uris ? key.redirect_uris[0] : 'http://localhost'
      );
      const tokenPath = path.resolve(path.dirname(authStatus.path), 'token.json');
      if (fs.existsSync(tokenPath)) {
        oauth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
        return oauth2Client;
      }
      throw new Error(
        `Authentication required. No token.json found in ${path.dirname(authStatus.path)}`
      );
    }
  }

  // 2. SRE: Ambient Auth Search (reuse existing session auth)
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/gmail.readonly',
      ],
    });
    return await auth.getClient();
  } catch (e) {
    throw new Error(
      'No Google credentials found. Place JSON key at knowledge/personal/connections/google/google-credentials.json'
    );
  }
}

async function listEvents(isDryRun) {
  if (isDryRun) {
    // Mock data for simulation
    const today = new Date().toISOString().split('T')[0];
    return [
      {
        id: 'evt_1',
        summary: 'Daily Standup (Mock)',
        start: `${today}T09:30:00`,
        end: `${today}T10:00:00`,
        status: 'confirmed',
      },
      {
        id: 'evt_2',
        summary: 'SRE Incident Review (Mock)',
        start: `${today}T11:00:00`,
        end: `${today}T12:00:00`,
        status: 'confirmed',
      },
      {
        id: 'evt_3',
        summary: 'UX Design Sync (Mock)',
        start: `${today}T14:00:00`,
        end: `${today}T15:00:00`,
        status: 'tentative',
      },
    ];
  }

  const auth = await getAuthenticatedClient();
  auth.scopes = ['https://www.googleapis.com/auth/calendar.readonly'];
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (res.data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date,
    status: e.status,
  }));
}

function draftEmail(input, to) {
  let subject = 'Update',
    body = '';
  if (input) {
    try {
      const data = JSON.parse(fs.readFileSync(input, 'utf8'));
      subject = data.subject || data.title || 'Update';
      body = data.body || data.content || JSON.stringify(data, null, 2);
    } catch (_e) {
      body = fs.readFileSync(input, 'utf8');
    }
  }
  return {
    to: to || 'stakeholders@company.com',
    subject,
    body: body.substring(0, 2000),
    format: 'text/plain',
  };
}

function draftDoc(input) {
  let title = 'Document',
    content = '';
  if (input) {
    try {
      const data = JSON.parse(fs.readFileSync(input, 'utf8'));
      title = data.title || 'Report';
      content = data.content || JSON.stringify(data, null, 2);
    } catch (_e) {
      content = fs.readFileSync(input, 'utf8');
      title = path.basename(input, path.extname(input));
    }
  }
  return { title, content: content.substring(0, 5000), format: 'text/markdown' };
}

function prepareSheetData(input) {
  if (!input) return { headers: [], rows: [] };
  try {
    const data = JSON.parse(fs.readFileSync(input, 'utf8'));
    if (Array.isArray(data) && data.length > 0) {
      const headers = Object.keys(data[0]);
      const rows = data.map((row) => headers.map((h) => row[h] ?? ''));
      return { headers, rows: rows.slice(0, 100), totalRows: data.length };
    }
    return { headers: Object.keys(data), rows: [Object.values(data)], totalRows: 1 };
  } catch (_e) {
    return {
      headers: ['content'],
      rows: [[fs.readFileSync(input, 'utf8').substring(0, 500)]],
      totalRows: 1,
    };
  }
}

async function startAuthFlow() {
  const authStatus = checkAuth();
  const content = fs.readFileSync(authStatus.path, 'utf8');
  const credentials = JSON.parse(content);
  const key = credentials.installed || credentials.web;

  const oauth2Client = new google.auth.OAuth2(
    key.client_id,
    key.client_secret,
    'http://localhost' // Standard local redirect
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  });

  const tmpAuthPath = path.resolve(rootDir, pathResolver.shared('google-auth-url.txt'));
  fs.writeFileSync(tmpAuthPath, authUrl);

  return {
    message: 'Authorization URL generated safely',
    url_file: pathResolver.shared('google-auth-url.txt'),
    instructions:
      'The URL has been saved to a file to prevent security leakage. browser-navigator will use this file.',
  };
}

runSkillAsync('google-workspace-integrator', async () => {
  const auth = checkAuth();
  const isDryRun = argv['dry-run'];
  let actionResult;

  try {
    switch (argv.action) {
      case 'auth-login':
        actionResult = await startAuthFlow();
        break;
      case 'list-events':
        actionResult = await listEvents(isDryRun);
        break;
      // ... existing cases
      default:
        actionResult = {
          message: 'Google Workspace connection ready',
          services: ['Calendar', 'Gmail'],
        };
    }
  } catch (err) {
    err.code = err.code || 'GOOGLE_API_ERROR';
    throw err;
  }

  const result = {
    action: argv.action,
    mode: isDryRun ? 'dry-run' : 'live',
    authStatus: auth.configured ? 'configured' : 'not_configured',
    result: actionResult,
    recommendations: !auth.configured
      ? ['Add service account JSON to knowledge/personal/google-credentials.json']
      : [],
  };

  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
