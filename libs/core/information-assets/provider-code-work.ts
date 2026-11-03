import { buildReviewThreadsCaptureParams } from '../service/service-capture-admission.js';
import type { InformationAssetCollector, CollectorSubject } from './provider.js';
import { object, rows, text, optionalText, jsonObject, providerRevision } from './provider.js';

export const githubReviewCollector: InformationAssetCollector = {
  id: 'github.review_requests',
  service_id: 'github',
  asset_types: ['code.review_request'],
  actions: ['list_pulls', 'list_reviews', 'get_commit_check_runs', 'get_review_threads'],
  async collect(location, cursor, call) {
    const owner = text(location.selectors.owner, 'owner');
    const repo = text(location.selectors.repo, 'repo');
    const page = cursor.page_token ? Number(cursor.page_token) : 1;
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('collector_invalid_github_page');
    const perPage = 100;
    const pulls = rows(
      await call('list_pulls', {
        vars: { owner, repo },
        query: {
          state: 'open',
          sort: 'updated',
          direction: 'asc',
          page,
          per_page: perPage,
        },
      })
    );
    if (pulls.length > perPage) throw new Error('collector_github_page_exceeded');
    const subjects: CollectorSubject[] = [];
    for (const pull of pulls) {
      const id = String(pull.number ?? '');
      if (!/^\d+$/.test(id)) throw new Error('collector_missing_pull_number');
      const updated = text(pull.updated_at, 'updated_at');
      const head = object(pull.head);
      const sha = text(head.sha, 'head_sha');
      const reviewers = rows(pull.requested_reviewers ?? []).map((row) =>
        text(row.login, 'reviewer')
      );
      let reviews: Record<string, unknown>[] = [],
        checks: Record<string, unknown>[] = [],
        threads: Record<string, unknown>[] = [];
      if (location.selectors.enrich_reviews !== false) {
        const vars = { owner, repo, pull_number: Number(id), ref: sha };
        for (let detailPage = 1; ; detailPage++) {
          const batch = rows(
            await call('list_reviews', { vars, query: { per_page: 100, page: detailPage } })
          );
          reviews.push(...batch);
          if (batch.length < 100) break;
          if (detailPage >= 10) throw new Error('collector_github_review_detail_limit');
        }
        for (let detailPage = 1; ; detailPage++) {
          const response = object(
            await call('get_commit_check_runs', {
              vars,
              query: { per_page: 100, page: detailPage, filter: 'latest' },
            })
          );
          const batch = rows(response.check_runs);
          checks.push(...batch);
          if (batch.length < 100) break;
          if (detailPage >= 10) throw new Error('collector_github_check_detail_limit');
        }
        let after: string | undefined;
        for (let detailPage = 1; ; detailPage++) {
          const response = object(
            await call(
              'get_review_threads',
              buildReviewThreadsCaptureParams({
                owner,
                repo,
                number: Number(id),
                after: after ?? null,
              })
            )
          );
          if (response.errors) throw new Error('collector_github_graphql_error');
          const pullRequest = object(object(object(response.data).repository).pullRequest);
          if (pullRequest.headRefOid !== sha)
            throw new Error('collector_github_head_changed_during_enrichment');
          const threadPage = object(pullRequest.reviewThreads);
          threads.push(...rows(threadPage.nodes));
          const info = object(threadPage.pageInfo);
          if (info.hasNextPage !== true) break;
          const next = text(info.endCursor, 'review_thread_cursor');
          if (next === after || detailPage >= 10)
            throw new Error('collector_github_thread_detail_limit');
          after = next;
        }
      }
      const latestReviews = new Map<string, Record<string, unknown>>();
      for (const review of [...reviews].sort((a, b) =>
        String(a.submitted_at).localeCompare(String(b.submitted_at))
      )) {
        if (!review.user) continue;
        const user = object(review.user);
        latestReviews.set(String(user.id ?? user.login), review);
      }
      const additionalCommits = [...latestReviews.values()].some(
        (review) => typeof review.commit_id === 'string' && review.commit_id !== sha
      );
      const unresolved = threads.filter((thread) => thread.isResolved === false).length;
      const ciFailed = checks.some((check) =>
        ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(
          String(check.conclusion)
        )
      );
      subjects.push({
        subject_id: owner + '/' + repo + '/pull/' + id,
        change_id: updated + ':' + sha + ':' + providerRevision({ reviews, checks, threads }),
        event_type: 'review.observed',
        source_url: optionalText(pull.html_url),
        occurred_at: updated,
        data: jsonObject({
          ...pull,
          owner,
          repo,
          head_sha: sha,
          requested_reviewers: reviewers,
          review_requested: reviewers.length > 0 || rows(pull.requested_teams ?? []).length > 0,
          additional_commits: additionalCommits,
          unresolved_review_count: unresolved,
          ci_failed: ciFailed,
          number: Number(id),
          review_thread_id: threads.find((thread) => thread.isResolved === false)?.id,
          reviews,
          checks,
          review_threads: threads,
        }),
      });
    }
    const complete = pulls.length < perPage;
    return { subjects, complete, next: complete ? {} : { page_token: String(page + 1) } };
  },
};

export const jiraIssueCollector: InformationAssetCollector = {
  id: 'jira.issues',
  service_id: 'jira',
  asset_types: ['customer.request', 'workflow.approval_request'],
  actions: ['search_issues_enhanced'],
  async collect(location, cursor, call, now = new Date()) {
    const domain = text(location.selectors.domain, 'domain');
    const jql = text(location.selectors.jql, 'jql');
    const response = object(
      await call('search_issues_enhanced', {
        vars: { domain },
        query: {
          jql,
          maxResults: 100,
          fields: '*all',
          ...(cursor.page_token ? { nextPageToken: cursor.page_token } : {}),
        },
      })
    );
    const issues = rows(response.issues);
    if (issues.length > 100) throw new Error('collector_jira_page_exceeded');
    const subjects: CollectorSubject[] = issues.map((issue) => {
      const key = text(issue.key, 'issue_key');
      const fields = object(issue.fields);
      const updated = text(fields.updated, 'issue_updated');
      const overdue =
        typeof fields.duedate === 'string' &&
        Date.parse(fields.duedate) < now.getTime() &&
        !fields.resolution;
      return {
        subject_id: key,
        change_id: updated + (overdue ? ':overdue' : ':current'),
        event_type: 'issue.observed',
        source_url: 'https://' + domain + '.atlassian.net/browse/' + encodeURIComponent(key),
        occurred_at: updated,
        data: jsonObject({
          ...issue,
          domain,
          status: fields.status && object(fields.status).name,
          assignee:
            fields.assignee &&
            (object(fields.assignee).accountId ?? object(fields.assignee).displayName),
          due_date: fields.duedate,
          labels: fields.labels,
          resolved: !!fields.resolution,
          waiting_information:
            !!fields.status && object(fields.status).name === 'Waiting for information',
        }),
      };
    });
    const token = optionalText(response.nextPageToken);
    if (response.isLast === false && !token) throw new Error('collector_jira_missing_next_page');
    return { subjects, complete: !token, next: token ? { page_token: token } : {} };
  },
};

export const jiraApprovalCollector: InformationAssetCollector = {
  id: 'jira.approvals',
  service_id: 'jira',
  asset_types: ['workflow.approval_request'],
  actions: ['get_request_approvals'],
  async collect(location, cursor, call) {
    const domain = text(location.selectors.domain, 'domain');
    const issueKey = text(location.selectors.issue_key, 'issue_key');
    const start = cursor.page_token ? Number(cursor.page_token) : 0;
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('collector_invalid_jira_start');
    const response = object(
      await call('get_request_approvals', {
        vars: { domain, issue_key: issueKey },
        query: { start, limit: 100 },
      })
    );
    const approvals = rows(response.values);
    const subjects = approvals.map((approval) => {
      const id = String(approval.id ?? '');
      if (!id) throw new Error('collector_missing_approval_id');
      return {
        subject_id: issueKey + '/approval/' + id,
        change_id: providerRevision(approval),
        event_type: 'approval.observed',
        source_url: 'https://' + domain + '.atlassian.net/browse/' + encodeURIComponent(issueKey),
        data: jsonObject({
          issue_key: issueKey,
          domain,
          approval,
          approval_pending: approval.finalDecision === 'pending',
        }),
      };
    });
    const complete = response.isLastPage === true;
    if (!complete && approvals.length === 0) throw new Error('collector_jira_nonadvancing_page');
    return {
      subjects,
      complete,
      next: complete ? {} : { page_token: String(start + approvals.length) },
    };
  },
};
