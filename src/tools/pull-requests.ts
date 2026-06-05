import type { ToolDefinition } from './types.js';
import type { TfsClient } from '../tfs-client.js';
import type {
  TfsPullRequest,
  TfsPullRequestChange,
  TfsPullRequestChangesResponse,
  TfsPullRequestComment,
  TfsPullRequestCompletionOptions,
  TfsPullRequestCreateRequest,
  TfsPullRequestIteration,
  TfsPullRequestIterationsResponse,
  TfsPullRequestSearchResult,
  TfsPullRequestThread,
  TfsPullRequestThreadsResponse,
  TfsReviewer,
} from '../models/tfs.js';
import {
  buildPullRequestUrl,
  formatDate,
  formatErrorResponse,
  formatPullRequestDetails,
  formatPullRequestThreadStatus,
} from '../formatting/markdown.js';
import { getChangeTypeIcon } from '../formatting/icons.js';

function requireString(value: unknown, displayName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}

function projectPath(project: string, suffix: string): string {
  return `/${encodeURIComponent(project)}${suffix}`;
}

function repoPath(project: string, repositoryId: string, suffix: string): string {
  return projectPath(
    project,
    `/_apis/git/repositories/${encodeURIComponent(repositoryId)}${suffix}`
  );
}

function normalizeRepoPath(path: string | undefined | null): string {
  if (path === undefined || path === null) return '';
  const trimmed = path.trim();
  if (trimmed.length === 0) return '';
  let p = trimmed.replace(/\\/g, '/');
  if (!p.startsWith('/')) {
    p = '/' + p.replace(/^\/+/, '');
  }
  return p;
}

function basename(p: string): string {
  const cleaned = p.replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx === -1 ? cleaned : cleaned.substring(idx + 1);
}

function pathsMatchForPrComment(candidateRepoPath: string, normalizedTarget: string): boolean {
  const n = normalizeRepoPath(candidateRepoPath);
  if (n.length === 0 || normalizedTarget.length === 0) return false;
  if (n.toLowerCase() === normalizedTarget.toLowerCase()) return true;
  const a = basename(n);
  const b = basename(normalizedTarget);
  return a.length > 0 && b.length > 0 && a.toLowerCase() === b.toLowerCase();
}

function* enumerateChangePaths(change: TfsPullRequestChange): Generator<string> {
  if (change.item?.path && change.item.path.trim().length > 0) {
    yield change.item.path;
  }
  if (change.sourceServerItem?.path && change.sourceServerItem.path.trim().length > 0) {
    yield change.sourceServerItem.path;
  }
}

function findMatchingChangeForPath(
  changes: TfsPullRequestChange[],
  normalizedTarget: string
): TfsPullRequestChange | null {
  for (const c of changes) {
    for (const path of enumerateChangePaths(c)) {
      if (pathsMatchForPrComment(path, normalizedTarget)) {
        return c;
      }
    }
  }
  return null;
}

function resolveChanges(
  response: TfsPullRequestChangesResponse
): TfsPullRequestChange[] {
  if (response.changeEntries && response.changeEntries.length > 0) {
    return response.changeEntries;
  }
  return response.value ?? [];
}

async function getPullRequestIterations(
  client: TfsClient,
  project: string,
  repositoryId: string,
  pullRequestId: number
): Promise<TfsPullRequestIteration[]> {
  const url = client.url(repoPath(project, repositoryId, `/pullrequests/${pullRequestId}/iterations`), {
    'api-version': '6.0',
  });
  const response = await client.get<TfsPullRequestIterationsResponse>(
    url,
    "fetching the pull request iterations"
  );
  return response.value ?? [];
}

async function getPullRequestIterationChanges(
  client: TfsClient,
  project: string,
  repositoryId: string,
  pullRequestId: number,
  iterationId: number
): Promise<TfsPullRequestChange[]> {
  const url = client.url(
    repoPath(
      project,
      repositoryId,
      `/pullrequests/${pullRequestId}/iterations/${iterationId}/changes`
    ),
    { 'api-version': '6.0' }
  );
  const response = await client.get<TfsPullRequestChangesResponse>(
    url,
    "fetching the pull request iteration changes"
  );
  return resolveChanges(response);
}

const getPullRequests: ToolDefinition = {
  name: 'tfs_getpullrequests',
  description: "Fetches the pull requests of a Microsoft TFS repository",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      status: {
        type: 'string',
        description:
          "Status of the pull requests to filter (active, completed, abandoned) - optional",
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of results (default 25)',
      },
    },
    required: ['project', 'repositoryId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const status = typeof args.status === 'string' ? args.status : undefined;
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 25;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");

      const url = client.url(repoPath(project, repositoryId, '/pullrequests'), {
        'api-version': '6.0',
        $top: maxResults,
        'searchCriteria.status':
          status && status.trim().length > 0 ? status : undefined,
      });
      const response = await client.get<TfsPullRequestSearchResult>(
        url,
        'fetching the pull requests'
      );
      const pullRequests: TfsPullRequest[] = response.value ?? [];

      if (pullRequests.length === 0) {
        const statusFilter =
          status && status.trim().length > 0 ? ` with status '${status}'` : '';
        return `🔄 **No pull request found${statusFilter} for repository '${repositoryId}' in project '${project}'**\n\n💡 **The repository may not have any pull requests or they may have a different status**`;
      }

      const statusFilter2 =
        status && status.trim().length > 0 ? ` (${status})` : '';

      const ordered = [...pullRequests].sort((a, b) => {
        const at = a.creationDate ? Date.parse(a.creationDate) : 0;
        const bt = b.creationDate ? Date.parse(b.creationDate) : 0;
        return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
      });

      const lines: string[] = [];
      lines.push(
        `🔄 **Pull requests of repository ${repositoryId}${statusFilter2} (${pullRequests.length})**`
      );
      lines.push('');

      for (const pr of ordered) {
        lines.push('---');
        lines.push(formatPullRequestDetails(pr).trimEnd());
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching the pull requests', err, {
        Project: project,
        'Repository ID': repositoryId,
        Status: status ?? 'All',
        'Maximum results': maxResults,
      });
    }
  },
};

const getPullRequest: ToolDefinition = {
  name: 'tfs_getpullrequest',
  description: "Fetches the details of a specific Microsoft TFS pull request",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }

      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { 'api-version': '6.0' }
      );

      let pullRequest: TfsPullRequest | undefined;
      try {
        pullRequest = await client.get<TfsPullRequest>(
          url,
          'fetching the pull request'
        );
      } catch (innerErr) {
        // Mirror .NET: non-success returns null → not found message
        const status =
          (innerErr as { status?: number } | undefined)?.status ?? 0;
        if (status > 0 && status !== 200) {
          pullRequest = undefined;
        } else {
          throw innerErr;
        }
      }

      if (!pullRequest || pullRequest.pullRequestId === undefined) {
        return `❌ **Pull request not found**\n\n🔍 **Searched ID:** ${pullRequestId} in repository '${repositoryId}' of project '${project}'\n💡 **Check that the pull request ID is correct and that you have access permissions**`;
      }

      const lines: string[] = [];
      lines.push(`🔄 **Pull request details ${pullRequest.pullRequestId}**`);
      lines.push('');
      lines.push('---');
      lines.push(formatPullRequestDetails(pullRequest, true).trimEnd());

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching the pull request', err, {
        Project: project,
        'Repository ID': repositoryId,
        'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
      });
    }
  },
};

const createPullRequest: ToolDefinition = {
  name: 'tfs_createpullrequest',
  description: 'Creates a new Microsoft TFS pull request',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      sourceRefName: {
        type: 'string',
        description: 'Source branch name (e.g. refs/heads/feature-branch)',
      },
      targetRefName: {
        type: 'string',
        description: 'Target branch name (e.g. refs/heads/main)',
      },
      jiraTicketId: {
        type: 'string',
        description: 'Jira ticket ID (will be automatically prefixed to the title)',
      },
      title: { type: 'string', description: 'Pull request title' },
      description: {
        type: 'string',
        description: 'Pull request description (optional)',
      },
      isDraft: {
        type: 'boolean',
        description: 'Create as draft (default false)',
      },
      reviewerIds: {
        type: 'string',
        description: 'Reviewer IDs separated by commas (optional)',
      },
    },
    required: [
      'project',
      'repositoryId',
      'sourceRefName',
      'targetRefName',
      'jiraTicketId',
      'title',
    ],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const sourceRefName =
      typeof args.sourceRefName === 'string' ? args.sourceRefName : '';
    const targetRefName =
      typeof args.targetRefName === 'string' ? args.targetRefName : '';
    const jiraTicketId =
      typeof args.jiraTicketId === 'string' ? args.jiraTicketId : '';
    const title = typeof args.title === 'string' ? args.title : '';
    const description =
      typeof args.description === 'string' ? args.description : undefined;
    const isDraft = typeof args.isDraft === 'boolean' ? args.isDraft : false;
    const reviewerIds =
      typeof args.reviewerIds === 'string' ? args.reviewerIds : undefined;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      requireString(sourceRefName, 'The source branch');
      requireString(targetRefName, 'The target branch');
      requireString(jiraTicketId, "The Jira ticket ID");
      requireString(title, 'The title');

      const expectedPrefixWithJira = `#JIRA${jiraTicketId}`;
      const expectedPrefixWithoutJira = `#${jiraTicketId}`;
      const lowerTitle = title.toLowerCase();
      const formattedTitle =
        lowerTitle.startsWith(expectedPrefixWithJira.toLowerCase()) ||
        lowerTitle.startsWith(expectedPrefixWithoutJira.toLowerCase())
          ? title
          : `${expectedPrefixWithJira} ${title}`;

      const reviewerList: string[] | undefined =
        reviewerIds && reviewerIds.trim().length > 0
          ? reviewerIds
              .split(',')
              .map((id) => id.trim())
              .filter((id) => id.length > 0)
          : undefined;

      const reviewers: TfsReviewer[] =
        reviewerList?.map((id) => ({ id, isRequired: false })) ?? [];

      const createRequest: TfsPullRequestCreateRequest = {
        sourceRefName,
        targetRefName,
        title: formattedTitle,
        description: description ?? '',
        isDraft,
        reviewers,
      };

      const url = client.url(repoPath(project, repositoryId, '/pullrequests'), {
        'api-version': '6.0',
      });

      const pullRequest = await client.request<TfsPullRequest>(
        'POST',
        url,
        createRequest,
        { operationName: 'creating the pull request' }
      );

      const repositoryName = pullRequest.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        pullRequest.pullRequestId ?? 0
      );

      let result =
        `✅ **Microsoft TFS pull request created successfully!**\n\n` +
        `🆔 **ID:** ${pullRequest.pullRequestId ?? ''}\n` +
        `📁 **Project:** ${project}\n` +
        `📂 **Repository:** ${repositoryId}\n` +
        `🎫 **Jira ticket:** ${jiraTicketId}\n` +
        `📋 **Title:** ${formattedTitle}\n` +
        `🌿 **Source:** ${sourceRefName}\n` +
        `🎯 **Target:** ${targetRefName}\n` +
        `📊 **Status:** ${pullRequest.status ?? ''}\n`;
      if (isDraft) {
        result += `📝 **Draft:** Yes\n`;
      }
      if (description && description.length > 0) {
        result += `📝 **Description:** ${description}\n`;
      }
      if (reviewerList && reviewerList.length > 0) {
        result += `👥 **Reviewers:** ${reviewerList.length}\n`;
      }
      result += `🔗 **Link:** ${pullRequestUrl}`;
      return result;
    } catch (err) {
      return formatErrorResponse('creating the Microsoft TFS pull request', err, {
        Project: project,
        'Repository ID': repositoryId,
        'Source branch': sourceRefName,
        'Target branch': targetRefName,
        'Jira ticket': jiraTicketId,
        Title: title,
        Description: description ?? 'None',
        Draft: isDraft,
        Reviewers: reviewerIds ?? 'None',
      });
    }
  },
};

const updatePullRequest: ToolDefinition = {
  name: 'tfs_updatepullrequest',
  description: 'Updates an existing Microsoft TFS pull request',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: {
        type: 'integer',
        description: "The ID of the pull request to update",
      },
      title: { type: 'string', description: 'The new title (optional)' },
      description: {
        type: 'string',
        description: 'The new description (optional)',
      },
      status: {
        type: 'string',
        description: 'The new status (active, completed, abandoned) (optional)',
      },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;
    const title = typeof args.title === 'string' ? args.title : undefined;
    const description =
      typeof args.description === 'string' ? args.description : undefined;
    const status = typeof args.status === 'string' ? args.status : undefined;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }

      const hasTitle = typeof title === 'string' && title.trim().length > 0;
      const hasDescription =
        typeof description === 'string' && description.trim().length > 0;
      const hasStatus = typeof status === 'string' && status.trim().length > 0;

      if (!hasTitle && !hasDescription && !hasStatus) {
        throw new Error('At least one field to update must be provided');
      }

      const updateRequest: Record<string, string> = {};
      if (hasTitle && title !== undefined) updateRequest.title = title;
      if (hasDescription && description !== undefined)
        updateRequest.description = description;
      if (hasStatus && status !== undefined) updateRequest.status = status;

      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { 'api-version': '6.0' }
      );

      const updatedPullRequest = await client.request<TfsPullRequest>(
        'PATCH',
        url,
        updateRequest,
        { operationName: 'updating the pull request' }
      );

      const updateDetails: string[] = [];
      if (hasTitle) updateDetails.push(`📋 **Title:** ${title}`);
      if (hasDescription) updateDetails.push(`📝 **Description:** ${description}`);
      if (hasStatus) updateDetails.push(`📊 **Status:** ${status}`);

      const repositoryName = updatedPullRequest.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updatedPullRequest.pullRequestId ?? pullRequestId
      );

      return (
        `✅ **Microsoft TFS pull request updated successfully!**\n\n` +
        `🔑 **ID:** ${updatedPullRequest.pullRequestId ?? ''}\n` +
        `📁 **Project:** ${project}\n` +
        `📂 **Repository:** ${repositoryId}\n\n` +
        `**Updated fields:**\n` +
        updateDetails.join('\n') +
        `\n\n` +
        `🔗 **Link:** ${pullRequestUrl}`
      );
    } catch (err) {
      return formatErrorResponse('updating the Microsoft TFS pull request', err, {
        Project: project,
        'Repository ID': repositoryId,
        'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
        Title: title ?? 'Unchanged',
        Description: description ?? 'Unchanged',
        Status: status ?? 'Unchanged',
      });
    }
  },
};

const abandonPullRequest: ToolDefinition = {
  name: 'tfs_abandonpullrequest',
  description: 'Abandons a Microsoft TFS pull request (PATCH status=abandoned)',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: {
        type: 'integer',
        description: "The ID of the pull request to abandon",
      },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }

      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { 'api-version': '6.0' }
      );

      try {
        await client.request<unknown>(
          'PATCH',
          url,
          { status: 'abandoned' },
          { operationName: "abandoning the pull request" }
        );
      } catch (innerErr) {
        const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
        return `❌ **Error while abandoning the pull request:**\n\n⚠️ ${message}`;
      }

      return (
        `✅ **Microsoft TFS pull request abandoned successfully!**\n\n` +
        `🔑 **Abandoned ID:** ${pullRequestId}\n` +
        `📁 **Project:** ${project}\n` +
        `📂 **Repository:** ${repositoryId}\n\n` +
        `⚠️ **Note:** The pull request has been marked as 'abandoned' and can no longer be merged.`
      );
    } catch (err) {
      return formatErrorResponse("abandoning the Microsoft TFS pull request", err, {
        Project: project,
        'Repository ID': repositoryId,
        'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
      });
    }
  },
};

const VOTE_VALUE_BY_NAME: Record<string, number> = {
  approve: 10,
  approveWithSuggestions: 5,
  reset: 0,
  waitForAuthor: -5,
  reject: -10,
};

function voteLabel(vote: string): string {
  switch (vote) {
    case 'approve':
      return '✅ Approved';
    case 'approveWithSuggestions':
      return '☑️ Approved with suggestions';
    case 'waitForAuthor':
      return '⏳ Waiting for the author';
    case 'reject':
      return '❌ Rejected';
    case 'reset':
      return '↩️ Vote reset';
    default:
      return vote;
  }
}

const voteOnPullRequest: ToolDefinition = {
  name: 'tfs_voteonpullrequest',
  description:
    "Votes on a Microsoft TFS pull request as a reviewer. " +
    "'vote' values: " +
    "'approve' = approve (10), " +
    "'approveWithSuggestions' = approve with suggestions (5), " +
    "'waitForAuthor' = wait for the author (-5), " +
    "'reject' = reject (-10), " +
    "'reset' = reset your vote (0). " +
    "By default the vote is cast for the authenticated user (resolved via connectionData); " +
    "provide reviewerId to vote on behalf of another reviewer (impersonation, requires permissions).",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
      vote: {
        type: 'string',
        enum: ['approve', 'approveWithSuggestions', 'waitForAuthor', 'reject', 'reset'],
        description:
          "Vote action: approve (10) | approveWithSuggestions (5) | waitForAuthor (-5) | reject (-10) | reset (0)",
      },
      reviewerId: {
        type: 'string',
        description:
          "Reviewer GUID; optional, default = authenticated user resolved via /_apis/connectionData",
      },
    },
    required: ['project', 'repositoryId', 'pullRequestId', 'vote'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;
    const vote = typeof args.vote === 'string' ? args.vote : '';
    const reviewerIdArg =
      typeof args.reviewerId === 'string' && args.reviewerId.trim().length > 0
        ? args.reviewerId.trim()
        : undefined;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      requireString(vote, "The vote action");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      if (!(vote in VOTE_VALUE_BY_NAME)) {
        throw new Error(
          `Invalid vote '${vote}'. Expected values: approve, approveWithSuggestions, waitForAuthor, reject, reset`
        );
      }

      const reviewerId = reviewerIdArg ?? (await client.getAuthenticatedUserId());
      const voteValue = VOTE_VALUE_BY_NAME[vote];

      const url = client.url(
        repoPath(
          project,
          repositoryId,
          `/pullrequests/${pullRequestId}/reviewers/${encodeURIComponent(reviewerId)}`
        ),
        { 'api-version': '6.0' }
      );

      await client.request<unknown>(
        'PUT',
        url,
        { vote: voteValue, id: reviewerId },
        { operationName: 'voting on the pull request' }
      );

      const pullRequestUrl = buildPullRequestUrl(project, repositoryId, pullRequestId);
      return (
        `${voteLabel(vote)} **on the pull request!**\n\n` +
        `🔑 **Pull Request:** ${pullRequestId}\n` +
        `📂 **Repository:** ${repositoryId}\n` +
        `📁 **Project:** ${project}\n` +
        `👤 **Reviewer:** ${reviewerId}${reviewerIdArg ? '' : ' (self)'}\n` +
        `🗳️ **Vote:** ${vote} (${voteValue})\n` +
        `🔗 **Link:** ${pullRequestUrl}`
      );
    } catch (err) {
      return formatErrorResponse('voting on the pull request', err, {
        Project: project,
        'Repository ID': repositoryId,
        'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
        Vote: vote,
        'Reviewer ID': reviewerIdArg ?? 'self (auto)',
      });
    }
  },
};

function buildCompletionOptions(
  mergeStrategy: string | undefined,
  deleteSourceBranch: boolean | undefined,
  mergeCommitMessage: string | undefined
): TfsPullRequestCompletionOptions {
  const opts: TfsPullRequestCompletionOptions = {};
  if (mergeStrategy && mergeStrategy.length > 0) opts.mergeStrategy = mergeStrategy;
  if (typeof deleteSourceBranch === 'boolean') opts.deleteSourceBranch = deleteSourceBranch;
  if (mergeCommitMessage && mergeCommitMessage.length > 0)
    opts.mergeCommitMessage = mergeCommitMessage;
  return opts;
}

const VALID_MERGE_STRATEGIES = new Set([
  'noFastForward',
  'rebase',
  'rebaseMerge',
  'squash',
]);

const completePullRequest: ToolDefinition = {
  name: 'tfs_completepullrequest',
  description:
    'Completes (merges) a Microsoft TFS pull request immediately. ' +
    "Fails if the policies are not satisfied (use setautocompletepullrequest otherwise).",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
      mergeStrategy: {
        type: 'string',
        enum: ['noFastForward', 'rebase', 'rebaseMerge', 'squash'],
        description: 'Merge strategy; default = squash',
      },
      deleteSourceBranch: {
        type: 'boolean',
        description: 'Delete the source branch after merge (optional)',
      },
      mergeCommitMessage: {
        type: 'string',
        description: 'Custom message for the merge commit (optional)',
      },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;
    const mergeStrategy =
      typeof args.mergeStrategy === 'string' && args.mergeStrategy.length > 0
        ? args.mergeStrategy
        : 'squash';
    const deleteSourceBranch =
      typeof args.deleteSourceBranch === 'boolean' ? args.deleteSourceBranch : undefined;
    const mergeCommitMessage =
      typeof args.mergeCommitMessage === 'string' ? args.mergeCommitMessage : undefined;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      if (!VALID_MERGE_STRATEGIES.has(mergeStrategy)) {
        throw new Error(
          `Invalid mergeStrategy '${mergeStrategy}'. Values: noFastForward, rebase, rebaseMerge, squash`
        );
      }

      const getUrl = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { 'api-version': '6.0' }
      );
      const pr = await client.get<TfsPullRequest>(
        getUrl,
        'fetching the pull request before completion'
      );
      const commitId = pr.lastMergeSourceCommit?.commitId;
      if (!commitId || commitId.length === 0) {
        throw new Error(
          "lastMergeSourceCommit.commitId not found on the pull request — unable to complete (PR not ready?)"
        );
      }

      const completionOptions = buildCompletionOptions(
        mergeStrategy,
        deleteSourceBranch,
        mergeCommitMessage
      );

      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { 'api-version': '6.0' }
      );

      const updated = await client.request<TfsPullRequest>(
        'PATCH',
        url,
        {
          status: 'completed',
          lastMergeSourceCommit: { commitId },
          completionOptions,
        },
        { operationName: 'completing the pull request' }
      );

      const repositoryName = updated.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updated.pullRequestId ?? pullRequestId
      );

      return (
        `✅ **Pull request completed successfully!**\n\n` +
        `🔑 **ID:** ${updated.pullRequestId ?? pullRequestId}\n` +
        `📁 **Project:** ${project}\n` +
        `📂 **Repository:** ${repositoryId}\n` +
        `📊 **Status:** ${updated.status ?? 'completed'}\n` +
        `🔀 **Strategy:** ${mergeStrategy}\n` +
        (deleteSourceBranch !== undefined
          ? `🗑️ **Source branch deleted:** ${deleteSourceBranch ? 'Yes' : 'No'}\n`
          : '') +
        (mergeCommitMessage ? `📝 **Merge message:** ${mergeCommitMessage}\n` : '') +
        `📍 **Source commit:** ${commitId.substring(0, 8)}...\n` +
        `🔗 **Link:** ${pullRequestUrl}`
      );
    } catch (err) {
      return formatErrorResponse('completing the pull request', err, {
        Project: project,
        'Repository ID': repositoryId,
        'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
        'Merge strategy': mergeStrategy,
        'Delete source branch': deleteSourceBranch === undefined ? 'Not specified' : deleteSourceBranch,
        'Merge message': mergeCommitMessage ?? 'None',
      });
    }
  },
};

const setAutoCompletePullRequest: ToolDefinition = {
  name: 'tfs_setautocompletepullrequest',
  description:
    "Enables auto-complete on a Microsoft TFS pull request. The merge triggers " +
    'automatically when all policies pass. autoCompleteSetBy is forced to ' +
    "the authenticated user (Microsoft TFS rejects an arbitrary GUID).",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
      mergeStrategy: {
        type: 'string',
        enum: ['noFastForward', 'rebase', 'rebaseMerge', 'squash'],
        description: 'Merge strategy; default = squash',
      },
      deleteSourceBranch: {
        type: 'boolean',
        description: 'Delete the source branch after merge (optional)',
      },
      mergeCommitMessage: {
        type: 'string',
        description: 'Custom message for the merge commit (optional)',
      },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;
    const mergeStrategy =
      typeof args.mergeStrategy === 'string' && args.mergeStrategy.length > 0
        ? args.mergeStrategy
        : 'squash';
    const deleteSourceBranch =
      typeof args.deleteSourceBranch === 'boolean' ? args.deleteSourceBranch : undefined;
    const mergeCommitMessage =
      typeof args.mergeCommitMessage === 'string' ? args.mergeCommitMessage : undefined;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      if (!VALID_MERGE_STRATEGIES.has(mergeStrategy)) {
        throw new Error(
          `Invalid mergeStrategy '${mergeStrategy}'. Values: noFastForward, rebase, rebaseMerge, squash`
        );
      }

      const selfId = await client.getAuthenticatedUserId();
      const completionOptions = buildCompletionOptions(
        mergeStrategy,
        deleteSourceBranch,
        mergeCommitMessage
      );

      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { 'api-version': '6.0' }
      );

      const updated = await client.request<TfsPullRequest>(
        'PATCH',
        url,
        {
          autoCompleteSetBy: { id: selfId },
          completionOptions,
        },
        { operationName: "enabling auto-complete on the pull request" }
      );

      const repositoryName = updated.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updated.pullRequestId ?? pullRequestId
      );

      return (
        `⚙️ **Auto-complete enabled on the pull request!**\n\n` +
        `🔑 **ID:** ${updated.pullRequestId ?? pullRequestId}\n` +
        `📁 **Project:** ${project}\n` +
        `📂 **Repository:** ${repositoryId}\n` +
        `👤 **Set by:** ${selfId} (self)\n` +
        `🔀 **Strategy:** ${mergeStrategy}\n` +
        (deleteSourceBranch !== undefined
          ? `🗑️ **Source branch deleted:** ${deleteSourceBranch ? 'Yes' : 'No'}\n`
          : '') +
        (mergeCommitMessage ? `📝 **Merge message:** ${mergeCommitMessage}\n` : '') +
        `⏱️ **The merge will trigger once policies are satisfied**\n` +
        `🔗 **Link:** ${pullRequestUrl}`
      );
    } catch (err) {
      return formatErrorResponse("enabling auto-complete on the pull request", err, {
        Project: project,
        'Repository ID': repositoryId,
        'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
        'Merge strategy': mergeStrategy,
        'Delete source branch': deleteSourceBranch === undefined ? 'Not specified' : deleteSourceBranch,
        'Merge message': mergeCommitMessage ?? 'None',
      });
    }
  },
};

async function patchDraftFlag(
  client: import('../tfs-client.js').TfsClient,
  project: string,
  repositoryId: string,
  pullRequestId: number,
  isDraft: boolean,
  operationName: string
): Promise<TfsPullRequest> {
  const url = client.url(
    repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
    { 'api-version': '6.0' }
  );
  return client.request<TfsPullRequest>(
    'PATCH',
    url,
    { isDraft },
    { operationName }
  );
}

const markPullRequestDraft: ToolDefinition = {
  name: 'tfs_markpullrequestdraft',
  description: 'Marks a Microsoft TFS pull request as draft (isDraft=true)',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }

      const updated = await patchDraftFlag(
        client,
        project,
        repositoryId,
        pullRequestId,
        true,
        'marking the pull request as draft'
      );

      const repositoryName = updated.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updated.pullRequestId ?? pullRequestId
      );

      return (
        `📝 **Pull request marked as draft!**\n\n` +
        `🔑 **ID:** ${updated.pullRequestId ?? pullRequestId}\n` +
        `📁 **Project:** ${project}\n` +
        `📂 **Repository:** ${repositoryId}\n` +
        `📝 **Draft:** Yes\n` +
        `🔗 **Link:** ${pullRequestUrl}`
      );
    } catch (err) {
      return formatErrorResponse('marking the pull request as draft', err, {
        Project: project,
        'Repository ID': repositoryId,
        'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
      });
    }
  },
};

const publishPullRequest: ToolDefinition = {
  name: 'tfs_publishpullrequest',
  description: "Takes a Microsoft TFS pull request out of draft mode (isDraft=false)",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }

      const updated = await patchDraftFlag(
        client,
        project,
        repositoryId,
        pullRequestId,
        false,
        'publishing the pull request (out of draft)'
      );

      const repositoryName = updated.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updated.pullRequestId ?? pullRequestId
      );

      return (
        `🚀 **Pull request published (out of draft)!**\n\n` +
        `🔑 **ID:** ${updated.pullRequestId ?? pullRequestId}\n` +
        `📁 **Project:** ${project}\n` +
        `📂 **Repository:** ${repositoryId}\n` +
        `📝 **Draft:** No\n` +
        `🔗 **Link:** ${pullRequestUrl}`
      );
    } catch (err) {
      return formatErrorResponse('publishing the pull request', err, {
        Project: project,
        'Repository ID': repositoryId,
        'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
      });
    }
  },
};

const getPullRequestComments: ToolDefinition = {
  name: 'tfs_getpullrequestcomments',
  description: "Fetches the comments of a Microsoft TFS pull request",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }

      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}/threads`),
        { 'api-version': '6.0' }
      );

      const response = await client.get<TfsPullRequestThreadsResponse>(
        url,
        'fetching the pull request comments'
      );

      const threads: TfsPullRequestThread[] = response.value ?? [];
      const comments: TfsPullRequestComment[] = [];
      for (const thread of threads) {
        const threadId = typeof thread.id === 'number' ? thread.id : 0;
        const threadStatus = formatPullRequestThreadStatus(thread);
        const threadComments = thread.comments ?? [];
        for (const c of threadComments) {
          comments.push({ ...c, threadId, threadStatus });
        }
      }

      if (comments.length === 0) {
        return `💬 **No comment found for pull request ${pullRequestId}**\n\n📂 **Repository:** ${repositoryId}\n📁 **Project:** ${project}`;
      }

      const ordered = [...comments].sort((a, b) => {
        const at = a.publishedDate ? Date.parse(a.publishedDate) : 0;
        const bt = b.publishedDate ? Date.parse(b.publishedDate) : 0;
        return (Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt);
      });

      const lines: string[] = [];
      lines.push(
        `💬 **Pull request comments ${pullRequestId} (${comments.length})**`
      );
      lines.push('');

      for (const comment of ordered) {
        lines.push('---');
        if (comment.threadId !== 0) {
          lines.push(`🧵 **Thread ID:** ${comment.threadId}`);
        }
        if (comment.threadStatus && comment.threadStatus.length > 0) {
          lines.push(`📌 **Thread status:** ${comment.threadStatus}`);
        }
        lines.push(`🔑 **Comment ID:** ${comment.id ?? ''}`);
        if (comment.author) {
          lines.push(`👤 **Author:** ${comment.author.displayName ?? ''}`);
        }
        const publishedDate = formatDate(comment.publishedDate);
        if (publishedDate) {
          lines.push(`📅 **Published on:** ${publishedDate}`);
        }
        if (
          comment.lastUpdatedDate &&
          comment.lastUpdatedDate !== comment.publishedDate
        ) {
          const lastUpdated = formatDate(comment.lastUpdatedDate);
          if (lastUpdated) {
            lines.push(`🔄 **Modified on:** ${lastUpdated}`);
          }
        }
        lines.push(`📝 **Content:**`);
        lines.push(comment.content ?? '');
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse(
        'fetching the pull request comments',
        err,
        {
          Project: project,
          'Repository ID': repositoryId,
          'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
        }
      );
    }
  },
};

const addPullRequestComment: ToolDefinition = {
  name: 'tfs_addpullrequestcomment',
  description:
    'Adds a comment to a Microsoft TFS pull request. Without filePath: general comment. With filePath + lineStart: comment anchored on one or more lines (right side of the diff, resulting file).',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
      comment: { type: 'string', description: 'The comment to add' },
      filePath: {
        type: 'string',
        description:
          'File path in the repo (e.g. /src/Service.cs), same form as in the diff; optional for a general comment',
      },
      lineStart: {
        type: 'integer',
        description:
          'Start line number on the right file (>= 1), required if filePath is provided',
      },
      lineEnd: {
        type: 'integer',
        description:
          'End line number (inclusive); default = lineStart for a single line',
      },
      startColumnOffset: {
        type: 'integer',
        description: 'Start column offset (1-based), default 1',
      },
      endColumnOffset: {
        type: 'integer',
        description: 'End column offset (1-based), default 1',
      },
      iterationId: {
        type: 'integer',
        description:
          "Iteration used to resolve the file / changeTrackingId (default: latest iteration or the one aligned with secondComparingIteration)",
      },
      firstComparingIteration: {
        type: 'integer',
        description: 'First iteration of the comparison context (default 1)',
      },
      secondComparingIteration: {
        type: 'integer',
        description:
          'Second iteration of the context (default: latest iteration of the PR)',
      },
      changeTrackingId: {
        type: 'integer',
        description:
          "Microsoft TFS changeTrackingId; if omitted, inferred from filePath via the iteration changes",
      },
    },
    required: ['project', 'repositoryId', 'pullRequestId', 'comment'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;
    const comment = typeof args.comment === 'string' ? args.comment : '';
    const filePath = typeof args.filePath === 'string' ? args.filePath : undefined;
    const lineStart =
      typeof args.lineStart === 'number' ? args.lineStart : undefined;
    const lineEnd =
      typeof args.lineEnd === 'number' ? args.lineEnd : undefined;
    const startColumnOffset =
      typeof args.startColumnOffset === 'number'
        ? args.startColumnOffset
        : undefined;
    const endColumnOffset =
      typeof args.endColumnOffset === 'number' ? args.endColumnOffset : undefined;
    const iterationId =
      typeof args.iterationId === 'number' ? args.iterationId : undefined;
    const firstComparingIteration =
      typeof args.firstComparingIteration === 'number'
        ? args.firstComparingIteration
        : undefined;
    const secondComparingIteration =
      typeof args.secondComparingIteration === 'number'
        ? args.secondComparingIteration
        : undefined;
    const changeTrackingIdArg =
      typeof args.changeTrackingId === 'number' ? args.changeTrackingId : undefined;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      requireString(comment, 'The comment');
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }

      let commentRequest: Record<string, unknown>;
      const hasFilePath =
        typeof filePath === 'string' && filePath.trim().length > 0;

      if (!hasFilePath) {
        commentRequest = {
          comments: [
            {
              parentCommentId: 0,
              content: comment,
              commentType: 1,
            },
          ],
          status: 1,
        };
      } else {
        if (lineStart === undefined || lineStart < 1) {
          return `❌ **Error while adding the comment:**\n\n⚠️ For a comment on the code, lineStart (>= 1) is required with filePath.`;
        }

        const iterations = await getPullRequestIterations(
          client,
          project,
          repositoryId,
          pullRequestId
        );
        if (iterations.length === 0) {
          return `❌ **Error while adding the comment:**\n\n⚠️ No iteration found for this pull request.`;
        }

        const ordered = [...iterations]
          .filter((i): i is TfsPullRequestIteration & { id: number } =>
            typeof i.id === 'number'
          )
          .sort((a, b) => b.id - a.id);

        const lastIterationId = ordered[0]?.id ?? 0;
        const resolvedSecond =
          secondComparingIteration ?? iterationId ?? lastIterationId;
        const resolvedFirst = firstComparingIteration ?? 1;

        const iterationForChanges = iterationId ?? resolvedSecond;
        let resolvedTracking: number | undefined = changeTrackingIdArg;
        let secondComparingForContext = resolvedSecond;

        if (resolvedTracking === undefined) {
          const normalizedTarget = normalizeRepoPath(filePath);
          if (normalizedTarget.length === 0) {
            return `❌ **Error while adding the comment:**\n\n⚠️ Invalid or empty file path after normalization.`;
          }

          const tryIterations: number[] = [];
          const addIterationId = (id: number): void => {
            if (id > 0 && !tryIterations.includes(id)) {
              tryIterations.push(id);
            }
          };

          addIterationId(iterationForChanges);
          addIterationId(resolvedSecond);
          for (const it of ordered) {
            addIterationId(it.id);
          }

          let match: TfsPullRequestChange | null = null;
          let matchIteration = 0;
          for (const iterId of tryIterations) {
            const iterChanges = await getPullRequestIterationChanges(
              client,
              project,
              repositoryId,
              pullRequestId,
              iterId
            );
            const candidate = findMatchingChangeForPath(iterChanges, normalizedTarget);
            if (candidate && (candidate.changeTrackingId ?? 0) !== 0) {
              match = candidate;
              matchIteration = iterId;
              break;
            }
          }

          if (!match || (match.changeTrackingId ?? 0) === 0) {
            const sampleChanges = await getPullRequestIterationChanges(
              client,
              project,
              repositoryId,
              pullRequestId,
              iterationForChanges
            );
            const samplePathsSet = new Set<string>();
            const samplePaths: string[] = [];
            for (const change of sampleChanges.slice(0, 40)) {
              for (const path of enumerateChangePaths(change)) {
                if (!path || path.trim().length === 0) continue;
                const key = path.toLowerCase();
                if (samplePathsSet.has(key)) continue;
                samplePathsSet.add(key);
                samplePaths.push(path);
                if (samplePaths.length >= 15) break;
              }
              if (samplePaths.length >= 15) break;
            }
            const sample = samplePaths.join(', ');
            return `❌ **Error while adding the comment:**\n\n⚠️ File not found in the tested iterations: '${filePath}'. Use changeTrackingId or a path aligned with the diff (e.g. /src/...). Examples: ${sample}`;
          }

          resolvedTracking = match.changeTrackingId ?? 0;
          secondComparingForContext = matchIteration;
        }

        let endLine = lineEnd ?? lineStart;
        if (endLine < lineStart) endLine = lineStart;
        const startOff = startColumnOffset ?? 1;
        const endOff = endColumnOffset ?? 1;

        commentRequest = {
          comments: [
            {
              parentCommentId: 0,
              content: comment,
              commentType: 1,
            },
          ],
          status: 1,
          threadContext: {
            filePath: normalizeRepoPath(filePath),
            rightFileStart: { line: lineStart, offset: startOff },
            rightFileEnd: { line: endLine, offset: endOff },
          },
          pullRequestThreadContext: {
            changeTrackingId: resolvedTracking,
            iterationContext: {
              firstComparingIteration: resolvedFirst,
              secondComparingIteration: secondComparingForContext,
            },
          },
        };
      }

      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}/threads`),
        { 'api-version': '6.0' }
      );

      try {
        await client.request<unknown>('POST', url, commentRequest, {
          operationName: "adding the comment to the pull request",
        });
      } catch (innerErr) {
        const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
        return `❌ **Error while adding the comment:**\n\n⚠️ ${message}`;
      }

      const anchor = !hasFilePath
        ? ''
        : `\n📍 **File:** \`${filePath}\`\n📏 **Lines:** ${lineStart}-${lineEnd ?? lineStart}\n`;

      return (
        `✅ **Comment added successfully to the pull request!**\n\n` +
        `🔑 **Pull Request:** ${pullRequestId}\n` +
        `📂 **Repository:** ${repositoryId}\n` +
        `📁 **Project:** ${project}\n` +
        anchor +
        `💬 **Comment:** ${comment}`
      );
    } catch (err) {
      return formatErrorResponse("adding the comment to the pull request", err, {
        Project: project,
        'Repository ID': repositoryId,
        'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
        Comment: comment,
      });
    }
  },
};

const getPullRequestDiff: ToolDefinition = {
  name: 'tfs_getpullrequestdiff',
  description: "Fetches the diff/changes of a Microsoft TFS pull request",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
      iterationId: {
        type: 'integer',
        description:
          "ID of the specific iteration (optional, default the first iteration)",
      },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;
    const iterationId =
      typeof args.iterationId === 'number' ? args.iterationId : undefined;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }

      let changes: TfsPullRequestChange[];
      if (iterationId !== undefined) {
        changes = await getPullRequestIterationChanges(
          client,
          project,
          repositoryId,
          pullRequestId,
          iterationId
        );
      } else {
        // Default: aggregate from latest iteration (matches .NET GetPullRequestChangesAsync)
        const iterations = await getPullRequestIterations(
          client,
          project,
          repositoryId,
          pullRequestId
        );
        if (iterations.length === 0) {
          changes = [];
        } else {
          const latest = [...iterations]
            .filter((i): i is TfsPullRequestIteration & { id: number } =>
              typeof i.id === 'number'
            )
            .sort((a, b) => b.id - a.id)[0];
          changes = latest
            ? await getPullRequestIterationChanges(
                client,
                project,
                repositoryId,
                pullRequestId,
                latest.id
              )
            : [];
        }
      }

      if (changes.length === 0) {
        return (
          `📄 **No change found for pull request ${pullRequestId}**\n\n` +
          `📂 **Repository:** ${repositoryId}\n` +
          `📁 **Project:** ${project}\n` +
          (iterationId !== undefined ? `🔄 **Iteration:** ${iterationId}\n` : '') +
          `💡 **The pull request may not have any changes or the specified iteration does not exist**`
        );
      }

      const lines: string[] = [];
      const iterationText =
        iterationId !== undefined ? ` (iteration ${iterationId})` : '';
      lines.push(
        `📄 **Changes of pull request ${pullRequestId}${iterationText} (${changes.length})**`
      );
      lines.push('');
      lines.push(`📂 **Repository:** ${repositoryId}`);
      lines.push(`📁 **Project:** ${project}`);
      lines.push('');

      const groups = new Map<string, TfsPullRequestChange[]>();
      for (const c of changes) {
        const key = c.changeType ?? '';
        const list = groups.get(key);
        if (list) list.push(c);
        else groups.set(key, [c]);
      }
      const orderedGroupKeys = [...groups.keys()].sort((a, b) =>
        a.localeCompare(b)
      );

      for (const key of orderedGroupKeys) {
        const group = groups.get(key) ?? [];
        const changeTypeIcon = getChangeTypeIcon(key);
        lines.push(`## ${changeTypeIcon} **${key}** (${group.length} file(s))`);
        lines.push('');

        const orderedGroup = [...group].sort((a, b) =>
          (a.item?.path ?? '').localeCompare(b.item?.path ?? '')
        );

        for (const change of orderedGroup) {
          lines.push(
            `📁 **Path:** \`${change.item?.path ?? '(no item)'}\``
          );
          if ((change.changeTrackingId ?? 0) !== 0) {
            lines.push(`🏷 **changeTrackingId:** ${change.changeTrackingId}`);
          }
          lines.push(`🔧 **Type:** ${change.changeType ?? ''}`);

          if (change.item?.isFolder === true) {
            lines.push(`📂 **Object type:** Folder`);
          } else {
            lines.push(
              `📄 **Object type:** File (${change.item?.gitObjectType ?? '?'})`
            );
          }

          const objectId = change.item?.objectId;
          if (objectId && objectId.length > 0) {
            lines.push(`🔑 **Object ID:** ${objectId.substring(0, 8)}...`);
          }

          if (
            change.sourceServerItem &&
            change.sourceServerItem.path &&
            change.sourceServerItem.path.length > 0
          ) {
            lines.push(`📍 **Source path:** \`${change.sourceServerItem.path}\``);
          }

          if (change.item?.url && change.item.url.length > 0) {
            lines.push(`🔗 **Link:** ${change.item.url}`);
          }

          lines.push('');
        }
      }

      lines.push('---');
      lines.push(`📊 **Summary:**`);
      for (const key of orderedGroupKeys) {
        const group = groups.get(key) ?? [];
        const changeTypeIcon = getChangeTypeIcon(key);
        lines.push(`- ${changeTypeIcon} ${key}: ${group.length} file(s)`);
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse(
        'fetching the pull request changes',
        err,
        {
          Project: project,
          'Repository ID': repositoryId,
          'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
          'Iteration ID': iterationId !== undefined ? String(iterationId) : 'First iteration',
        }
      );
    }
  },
};

const getPullRequestIterationsTool: ToolDefinition = {
  name: 'tfs_getpullrequestiterations',
  description: "Fetches the list of iterations of a Microsoft TFS pull request",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
    },
    required: ['project', 'repositoryId', 'pullRequestId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }

      const iterations = await getPullRequestIterations(
        client,
        project,
        repositoryId,
        pullRequestId
      );

      if (iterations.length === 0) {
        return (
          `🔄 **No iteration found for pull request ${pullRequestId}**\n\n` +
          `📂 **Repository:** ${repositoryId}\n` +
          `📁 **Project:** ${project}`
        );
      }

      const ordered = [...iterations].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

      const lines: string[] = [];
      lines.push(
        `🔄 **Iterations of pull request ${pullRequestId} (${iterations.length})**`
      );
      lines.push('');
      lines.push(`📂 **Repository:** ${repositoryId}`);
      lines.push(`📁 **Project:** ${project}`);
      lines.push('');

      for (const iteration of ordered) {
        lines.push('---');
        lines.push(`🔑 **ID:** ${iteration.id ?? ''}`);
        if (iteration.description && iteration.description.length > 0) {
          lines.push(`📝 **Description:** ${iteration.description}`);
        }
        if (iteration.author) {
          lines.push(`👤 **Author:** ${iteration.author.displayName ?? ''}`);
        }
        const createdDate = formatDate(iteration.createdDate);
        if (createdDate) {
          lines.push(`📅 **Created on:** ${createdDate}`);
        }
        const updatedDate = formatDate(iteration.updatedDate);
        if (updatedDate) {
          lines.push(`🔄 **Updated on:** ${updatedDate}`);
        }
        if (iteration.reason && iteration.reason.length > 0) {
          lines.push(`💡 **Reason:** ${iteration.reason}`);
        }
        if (iteration.sourceRefCommit?.commitId) {
          lines.push(
            `📍 **Source commit:** ${iteration.sourceRefCommit.commitId.substring(0, 8)}...`
          );
        }
        if (iteration.targetRefCommit?.commitId) {
          lines.push(
            `🎯 **Target commit:** ${iteration.targetRefCommit.commitId.substring(0, 8)}...`
          );
        }
        if (iteration.hasMoreCommits === true) {
          lines.push(`📚 **More commits:** Yes`);
        }
        if (iteration.push) {
          const pushDate = formatDate(iteration.push.date);
          lines.push(
            `⬆️ **Push ID:** ${iteration.push.pushId ?? ''} on ${pushDate ?? ''}`
          );
        }
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse(
        'fetching the pull request iterations',
        err,
        {
          Project: project,
          'Repository ID': repositoryId,
          'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
        }
      );
    }
  },
};

const THREAD_STATUS_BY_NAME: Record<string, number> = {
  active: 1,
  fixed: 2,
  wontFix: 3,
  closed: 4,
  byDesign: 5,
  pending: 6,
};

function threadStatusLabel(status: string): string {
  switch (status) {
    case 'fixed':
      return '✅ Resolved (fixed)';
    case 'closed':
      return '🔒 Closed (closed)';
    case 'wontFix':
      return '🚫 Will not be fixed (wontFix)';
    case 'byDesign':
      return '📐 By design (byDesign)';
    case 'active':
      return '🔵 Reactivated (active)';
    case 'pending':
      return '⏳ Pending (pending)';
    default:
      return status;
  }
}

const resolvePullRequestComment: ToolDefinition = {
  name: 'tfs_resolvepullrequestcomment',
  description:
    "Resolves (closes) a comment thread of a Microsoft TFS pull request by " +
    'changing its status. status values: ' +
    "'fixed' = resolved (default), 'closed' = closed, 'wontFix' = will not be fixed, " +
    "'byDesign' = by design, 'active' = reactivate, 'pending' = pending. " +
    "Use the threadId (Thread ID) returned by tfs_getpullrequestcomments.",
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'The Microsoft TFS project name' },
      repositoryId: { type: 'string', description: "The repository ID" },
      pullRequestId: { type: 'integer', description: "The pull request ID" },
      threadId: {
        type: 'integer',
        description:
          "The ID of the comment thread to resolve (Thread ID returned by tfs_getpullrequestcomments)",
      },
      status: {
        type: 'string',
        enum: ['fixed', 'closed', 'wontFix', 'byDesign', 'active', 'pending'],
        description:
          "New thread status; default = fixed (resolved). closed = closed, wontFix = will not be fixed, byDesign = by design, active = reactivate, pending = pending",
      },
    },
    required: ['project', 'repositoryId', 'pullRequestId', 'threadId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const repositoryId = typeof args.repositoryId === 'string' ? args.repositoryId : '';
    const pullRequestId =
      typeof args.pullRequestId === 'number' ? args.pullRequestId : NaN;
    const threadId = typeof args.threadId === 'number' ? args.threadId : NaN;
    const status =
      typeof args.status === 'string' && args.status.length > 0
        ? args.status
        : 'fixed';

    try {
      requireString(project, 'The project name');
      requireString(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      if (!Number.isFinite(threadId) || !Number.isInteger(threadId)) {
        throw new Error("The comment thread ID (threadId) is required");
      }
      if (!(status in THREAD_STATUS_BY_NAME)) {
        throw new Error(
          `Invalid status '${status}'. Expected values: fixed, closed, wontFix, byDesign, active, pending`
        );
      }

      const statusValue = THREAD_STATUS_BY_NAME[status];

      const url = client.url(
        repoPath(
          project,
          repositoryId,
          `/pullrequests/${pullRequestId}/threads/${threadId}`
        ),
        { 'api-version': '6.0' }
      );

      try {
        await client.request<unknown>(
          'PATCH',
          url,
          { status: statusValue },
          { operationName: 'resolving the pull request comment thread' }
        );
      } catch (innerErr) {
        const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
        return `❌ **Error while resolving the comment:**\n\n⚠️ ${message}`;
      }

      const pullRequestUrl = buildPullRequestUrl(project, repositoryId, pullRequestId);
      return (
        `${threadStatusLabel(status)} **— comment thread updated!**\n\n` +
        `🧵 **Thread ID:** ${threadId}\n` +
        `🔑 **Pull Request:** ${pullRequestId}\n` +
        `📂 **Repository:** ${repositoryId}\n` +
        `📁 **Project:** ${project}\n` +
        `📌 **New status:** ${status} (${statusValue})\n` +
        `🔗 **Link:** ${pullRequestUrl}`
      );
    } catch (err) {
      return formatErrorResponse(
        'resolving the pull request comment thread',
        err,
        {
          Project: project,
          'Repository ID': repositoryId,
          'Pull Request ID': Number.isFinite(pullRequestId) ? pullRequestId : '',
          'Thread ID': Number.isFinite(threadId) ? threadId : '',
          Status: status,
        }
      );
    }
  },
};

export const pullRequestTools: ToolDefinition[] = [
  getPullRequests,
  getPullRequest,
  createPullRequest,
  updatePullRequest,
  abandonPullRequest,
  voteOnPullRequest,
  completePullRequest,
  setAutoCompletePullRequest,
  markPullRequestDraft,
  publishPullRequest,
  getPullRequestComments,
  addPullRequestComment,
  resolvePullRequestComment,
  getPullRequestDiff,
  getPullRequestIterationsTool,
];
