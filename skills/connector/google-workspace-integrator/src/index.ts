/**
 * Google Workspace Integrator - CLI Entry Point
 * Implements 'fetch-agenda', 'list-emails', 'send-email', and 'auth' actions.
 */

// @ts-ignore
const { runSkillAsync } = require('@agent/core');
const { getGoogleAuth, fetchAgenda, formatAgenda, listEmails, sendEmail, exchangeCodeForToken } = require('./lib');
const { logger, safeWriteFile } = require('@agent/core/secure-io');
const pathResolver = require('@agent/core/path-resolver');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

async function main() {
  await runSkillAsync('google-workspace-integrator', async () => {
    const argv = yargs(hideBin(process.argv)).argv;
    const action = argv.action || argv._[0] || 'fetch-agenda';
    const auth = await getGoogleAuth();

    if (auth.status === 'missing_creds') {
      throw new Error('Google API Credentials missing. Please place google-credentials.json in knowledge/personal/connections/google/.');
    }

    // --- Action: auth ---
    if (action === 'auth') {
      if (argv.code) {
        logger.info('🔑 Exchanging authorization code for tokens...');
        const tokens = await exchangeCodeForToken(auth.client, argv.code as string);
        logger.success('✅ Tokens saved to knowledge/personal/connections/google/google-token.json');
        return { status: 'success', message: 'Authentication complete.', tokens: 'MASKED' };
      } else {
        const authUrl = auth.client.generateAuthUrl({
          access_type: 'offline',
          scope: [
            'https://www.googleapis.com/auth/calendar.readonly',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.send'
          ],
        });
        return {
          status: 'needs_attention',
          message: 'Authentication required.',
          auth_url: authUrl,
          instructions: '1. Visit the URL. 2. Authorize. 3. Run: node scripts/cli.cjs run google-workspace-integrator auth --code <YOUR_CODE>'
        };
      }
    }

    // Auto-guide if not authenticated
    if (auth.status === 'needs_auth') {
      return {
        status: 'needs_attention',
        message: 'Authentication required. Please run: node scripts/cli.cjs run google-workspace-integrator auth',
      };
    }

    switch (action) {
      case 'fetch-agenda':
        logger.info('📅 Fetching CEO Agenda...');
        const events = await fetchAgenda(auth.client, argv.limit || 5);
        const output = formatAgenda(events);
        const calArtifact = path.join(pathResolver.active('shared'), `ceo_agenda_${Date.now()}.md`);
        safeWriteFile(calArtifact, output);
        return { agenda: output, artifact: calArtifact };

      case 'list-emails':
        logger.info('📧 Fetching latest emails...');
        const emails = await listEmails(auth.client, argv.q || '', argv.limit || 10);
        const emailList = emails.map((e: any) => `- [${e.date}] FROM: ${e.from} | SUBJ: ${e.subject} (ID: ${e.id})`).join('\n');
        const emailArtifact = path.join(pathResolver.active('shared'), `ceo_emails_${Date.now()}.md`);
        safeWriteFile(emailArtifact, emailList);
        return { emails: emails, artifact: emailArtifact };

      case 'send-email':
        const { to, subject, body } = argv;
        if (!to || !subject || !body) {
          throw new Error('Missing arguments for send-email: --to, --subject, --body');
        }
        logger.info(`📤 Sending email to ${to}...`);
        const result = await sendEmail(auth.client, to, subject, body);
        return { status: 'success', messageId: result.id };

      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
