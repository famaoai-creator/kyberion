/**
 * Google Workspace Integrator - Core Library
 * Provides helpers for Auth, Calendar, and Gmail operations.
 * Strictly uses @agent/core for I/O and path resolution.
 */

// @ts-ignore
const { google } = require('googleapis');
const { safeReadFile, safeWriteFile } = require('@agent/core/secure-io');
const pathResolver = require('@agent/core/path-resolver');
import * as fs from 'node:fs';

// --- Auth Paths ---
const CREDENTIALS_PATH = pathResolver.rootResolve('knowledge/personal/connections/google/google-credentials.json');
const TOKEN_PATH = pathResolver.rootResolve('knowledge/personal/connections/google/google-token.json');

// --- Scopes ---
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send'
];

export interface GoogleAuthClient {
  client: any;
  status: 'authenticated' | 'needs_auth' | 'missing_creds';
}

/**
 * Initializes the OAuth2 client.
 */
export async function getGoogleAuth(): Promise<GoogleAuthClient> {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    return { client: null, status: 'missing_creds' };
  }

  const content = safeReadFile(CREDENTIALS_PATH, { encoding: 'utf8' }) as string;
  const keys = JSON.parse(content);
  const { client_secret, client_id, redirect_uris } = keys.installed || keys.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (!fs.existsSync(TOKEN_PATH)) {
    return { client: oAuth2Client, status: 'needs_auth' };
  }

  const token = JSON.parse(safeReadFile(TOKEN_PATH, { encoding: 'utf8' }) as string);
  oAuth2Client.setCredentials(token);
  return { client: oAuth2Client, status: 'authenticated' };
}

/**
 * Exchanges an auth code for a token and saves it.
 */
export async function exchangeCodeForToken(client: any, code: string): Promise<any> {
  const { tokens } = await client.getToken(code);
  safeWriteFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  return tokens;
}

// --- Calendar Logic ---

export async function fetchAgenda(auth: any, maxResults: number = 10) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: (new Date()).toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items || [];
}

export function formatAgenda(events: any[]): string {
  if (events.length === 0) return 'CEO, your schedule is clear for now.';
  const formatted = events.map((event: any) => {
    const start = event.start.dateTime || event.start.date;
    return `- [${new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] ${event.summary}`;
  });
  return `### 🗓️ CEO Agenda\n\n${formatted.join('\n')}`;
}

// --- Gmail Logic ---

export async function listEmails(auth: any, q: string = '', maxResults: number = 10) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults,
  });
  const messages = res.data.messages || [];
  
  const details = await Promise.all(messages.map(async (m: any) => {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
    const headers = msg.data.payload.headers;
    return {
      id: m.id,
      threadId: m.threadId,
      subject: headers.find((h: any) => h.name === 'Subject')?.value || '(No Subject)',
      from: headers.find((h: any) => h.name === 'From')?.value || 'Unknown',
      date: headers.find((h: any) => h.name === 'Date')?.value || ''
    };
  }));
  
  return details;
}

export async function sendEmail(auth: any, to: string, subject: string, body: string) {
  const gmail = google.gmail({ version: 'v1', auth });
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    `From: me`,
    `To: ${to}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    `Subject: ${utf8Subject}`,
    '',
    body,
  ];
  const message = messageParts.join('\n');
  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
    },
  });
  return res.data;
}
