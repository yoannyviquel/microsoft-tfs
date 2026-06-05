import type { ToolDefinition } from './types.js';
import type { TfsClient } from '../tfs-client.js';
import type {
  TfsBranch,
  TfsBranchDeletionResult,
  TfsBranchesResponse,
  TfsCleanBranchesResult,
  TfsPullRequest,
  TfsPullRequestSearchResult,
  TfsRepositoriesResponse,
  TfsRepository,
} from '../models/tfs.js';
import { formatErrorResponse } from '../formatting/markdown.js';

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

interface CommitDateShape {
  committer?: { date?: string };
  author?: { date?: string };
  push?: { date?: string };
}

async function getBranchLastCommitDate(
  client: TfsClient,
  project: string,
  repositoryId: string,
  commitId: string
): Promise<string | undefined> {
  try {
    const url = client.url(
      repoPath(project, repositoryId, `/commits/${encodeURIComponent(commitId)}`),
      { 'api-version': '6.0' }
    );

    let commit: CommitDateShape;
    try {
      commit = await client.get<CommitDateShape>(url, 'fetching the commit');
    } catch {
      return undefined;
    }

    const tryParse = (raw: string | undefined): string | undefined => {
      if (!raw || raw.trim().length === 0) return undefined;
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return undefined;
      return date.toISOString();
    };

    return (
      tryParse(commit.committer?.date) ??
      tryParse(commit.author?.date) ??
      tryParse(commit.push?.date)
    );
  } catch {
    return undefined;
  }
}

async function getBranches(
  client: TfsClient,
  project: string,
  repositoryId: string
): Promise<TfsBranch[]> {
  try {
    const url = client.url(repoPath(project, repositoryId, '/refs'), {
      filter: 'heads/',
      'api-version': '6.0',
    });
    const response = await client.get<TfsBranchesResponse>(
      url,
      'fetching the branches'
    );
    const branches: TfsBranch[] = response.value ?? [];

    for (const branch of branches) {
      if (branch.objectId) {
        branch.lastUpdateDate = await getBranchLastCommitDate(
          client,
          project,
          repositoryId,
          branch.objectId
        );
      }
    }

    return branches;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Error while fetching the branches: ${message}`);
  }
}

async function getRepositories(
  client: TfsClient,
  project: string
): Promise<TfsRepository[]> {
  const url = client.url(projectPath(project, '/_apis/git/repositories'), {
    'api-version': '6.0',
  });
  const response = await client.get<TfsRepositoriesResponse>(
    url,
    'fetching the repositories'
  );
  return response.value ?? [];
}

async function getPullRequestsForRepo(
  client: TfsClient,
  project: string,
  repositoryId: string,
  status: string,
  maxResults: number
): Promise<TfsPullRequest[]> {
  try {
    const url = client.url(repoPath(project, repositoryId, '/pullrequests'), {
      'api-version': '6.0',
      $top: maxResults,
      'searchCriteria.status': status,
    });
    const response = await client.get<TfsPullRequestSearchResult>(
      url,
      'fetching the pull requests'
    );
    return response.value ?? [];
  } catch {
    return [];
  }
}

async function deleteBranch(
  client: TfsClient,
  project: string,
  repositoryId: string,
  branchName: string
): Promise<TfsBranchDeletionResult> {
  try {
    const branches = await getBranches(client, project, repositoryId);
    const branch = branches.find(
      (b) => b.name === `refs/heads/${branchName}` || b.name === branchName
    );

    if (!branch || !branch.name || !branch.objectId) {
      return { success: false, errorMessage: 'Branch not found' };
    }

    const deleteRequest = [
      {
        name: branch.name,
        oldObjectId: branch.objectId,
        newObjectId: '0000000000000000000000000000000000000000',
      },
    ];

    const url = client.url(repoPath(project, repositoryId, '/refs'), {
      'api-version': '6.0',
    });

    let responseRaw: unknown;
    try {
      responseRaw = await client.request<unknown>('POST', url, deleteRequest, {
        operationName: 'deleting the branch',
      });
    } catch (innerErr) {
      const status =
        (innerErr as { status?: number } | undefined)?.status ?? 0;
      const message =
        innerErr instanceof Error ? innerErr.message : String(innerErr);

      if (status === 401 || status === 403) {
        return {
          success: false,
          errorMessage:
            `Insufficient permissions to delete the branch. ` +
            `HTTP code: ${status}. Message: ${message || 'Access denied'}`,
        };
      }
      return {
        success: false,
        errorMessage: `Error while deleting (Code: ${status}): ${message}`,
      };
    }

    // Check if response contains permission errors
    if (responseRaw && typeof responseRaw === 'object') {
      const root = responseRaw as {
        value?: unknown;
        message?: string;
        error?: string;
      };

      if (Array.isArray(responseRaw) && responseRaw.length === 0) {
        // Empty array → assume success but verify
      } else if (Array.isArray(root.value) && root.value.length === 0) {
        // Empty value array → assume success but verify
      } else {
        const errMsg = root.message ?? root.error;
        if (typeof errMsg === 'string' && errMsg.length > 0) {
          const lower = errMsg.toLowerCase();
          if (
            lower.includes('permission') ||
            lower.includes('access') ||
            lower.includes('denied') ||
            lower.includes('refusé')
          ) {
            return {
              success: false,
              errorMessage: `Insufficient permissions to delete the branch. Message: ${errMsg}`,
            };
          }
        }
      }
    }

    // Verify the branch was actually deleted (mirrors .NET re-check after 500ms delay)
    await new Promise((resolve) => setTimeout(resolve, 500));

    const branchesAfterDelete = await getBranches(client, project, repositoryId);
    const stillExists = branchesAfterDelete.some(
      (b) => b.name === `refs/heads/${branchName}` || b.name === branchName
    );

    if (stillExists) {
      return {
        success: false,
        errorMessage:
          'Insufficient permissions to delete the branch. The branch still exists after the deletion attempt.',
      };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorMessage: `Error while deleting the branch: ${message}`,
    };
  }
}

function containsCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function stripRefsHeads(name: string): string {
  return name.replace(/^refs\/heads\//, '');
}

function parseLastUpdate(branch: TfsBranch): number {
  if (!branch.lastUpdateDate) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(branch.lastUpdateDate);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

async function cleanBranches(
  client: TfsClient,
  project: string,
  dryRun: boolean,
  configKubeBranchesToKeep: number,
  branchRetentionMonths: number,
  keepBranchesWithOpenPr: boolean
): Promise<TfsCleanBranchesResult> {
  const result: TfsCleanBranchesResult = {
    totalRepositories: 0,
    eligibleRepositories: 0,
    totalBranches: 0,
    deletedBranches: 0,
    failedDeletions: 0,
    skippedBranchesWithPr: 0,
    skippedBranchesRecent: 0,
    hasPermissionErrors: false,
    deletedBranchesList: [],
    failedBranchesList: [],
    skippedRepositories: [],
    skippedBranchesWithPrList: [],
    skippedBranchesRecentList: [],
  };

  try {
    const repositories = await getRepositories(client, project);
    result.totalRepositories = repositories.length;

    // Compute retention cutoff: DateTime.UtcNow.AddMonths(-branchRetentionMonths)
    const now = new Date();
    const retentionDate = new Date(now.getTime());
    retentionDate.setUTCMonth(retentionDate.getUTCMonth() - branchRetentionMonths);
    const retentionMs = retentionDate.getTime();

    const branchesToDelete: { repo: TfsRepository; branchName: string }[] = [];

    const repoDataList = await Promise.all(
      repositories.map(async (repo) => {
        const repoId = repo.id ?? '';
        const isConfigKubeRepo = containsCaseInsensitive(
          repo.name ?? '',
          'config_kube'
        );
        const [branches, activePullRequests] = await Promise.all([
          getBranches(client, project, repoId),
          getPullRequestsForRepo(client, project, repoId, 'active', 100),
        ]);
        return {
          repo,
          isConfigKubeRepo,
          branches,
          activePullRequests,
        };
      })
    );

    for (const repoData of repoDataList) {
      const { repo, isConfigKubeRepo, branches, activePullRequests } = repoData;

      if (!isConfigKubeRepo) {
        result.eligibleRepositories++;
      }

      const branchesWithActivePr = new Set<string>();
      if (keepBranchesWithOpenPr) {
        for (const pr of activePullRequests) {
          const sourceBranch = (pr.sourceRefName ?? '')
            .replace(/^refs\/heads\//, '')
            .replace(/^refs\//, '');
          if (sourceBranch.trim().length > 0) {
            branchesWithActivePr.add(sourceBranch.toLowerCase());
          }
        }
      }

      if (isConfigKubeRepo) {
        // Sort branches by last update desc, keep top N (excluding master)
        const branchesToKeepSet = new Set<string>(
          [...branches]
            .filter((b) => !containsCaseInsensitive(b.name ?? '', 'master'))
            .sort((a, b) => parseLastUpdate(b) - parseLastUpdate(a))
            .slice(0, configKubeBranchesToKeep)
            .map((b) => stripRefsHeads(b.name ?? '').toLowerCase())
        );

        for (const branch of branches) {
          const branchName = stripRefsHeads(branch.name ?? '');
          if (containsCaseInsensitive(branchName, 'master')) {
            continue;
          }
          if (branchesToKeepSet.has(branchName.toLowerCase())) {
            continue;
          }
          result.totalBranches++;

          if (!dryRun) {
            branchesToDelete.push({ repo, branchName });
          } else {
            result.deletedBranchesList.push(`${repo.name ?? ''}/${branchName}`);
          }
        }
        continue;
      }

      for (const branch of branches) {
        const branchName = stripRefsHeads(branch.name ?? '');

        if (containsCaseInsensitive(branchName, 'master')) {
          continue;
        }

        if (
          keepBranchesWithOpenPr &&
          branchesWithActivePr.has(branchName.toLowerCase())
        ) {
          result.skippedBranchesWithPr++;
          result.skippedBranchesWithPrList.push(
            `${repo.name ?? ''}/${branchName}`
          );
          continue;
        }

        if (branch.lastUpdateDate) {
          const lastUpdateMs = Date.parse(branch.lastUpdateDate);
          if (!Number.isNaN(lastUpdateMs) && lastUpdateMs > retentionMs) {
            result.skippedBranchesRecent++;
            result.skippedBranchesRecentList.push(
              `${repo.name ?? ''}/${branchName}`
            );
            continue;
          }
        }

        result.totalBranches++;

        if (!dryRun) {
          branchesToDelete.push({ repo, branchName });
        } else {
          result.deletedBranchesList.push(`${repo.name ?? ''}/${branchName}`);
        }
      }
    }

    if (!dryRun && branchesToDelete.length > 0) {
      const CONCURRENCY = 10;
      let cursor = 0;

      const worker = async (): Promise<void> => {
        while (true) {
          const idx = cursor++;
          if (idx >= branchesToDelete.length) return;
          const item = branchesToDelete[idx];
          if (!item) return;
          const { repo, branchName } = item;
          const repoId = repo.id ?? '';

          try {
            const { success, errorMessage } = await deleteBranch(
              client,
              project,
              repoId,
              branchName
            );
            if (success) {
              result.deletedBranches++;
              result.deletedBranchesList.push(`${repo.name ?? ''}/${branchName}`);
            } else {
              result.failedDeletions++;
              const err = errorMessage ?? 'Unknown error';
              result.failedBranchesList.push(
                `${repo.name ?? ''}/${branchName} (${err})`
              );
              const lower = err.toLowerCase();
              if (
                lower.includes('insufficient permissions') ||
                lower.includes('access denied')
              ) {
                result.hasPermissionErrors = true;
              }
            }
          } catch (ex) {
            const errMsg = ex instanceof Error ? ex.message : String(ex);
            result.failedDeletions++;
            result.failedBranchesList.push(
              `${repo.name ?? ''}/${branchName} (${errMsg})`
            );
            const lower = errMsg.toLowerCase();
            // errMsg here is an unexpected exception message that may carry the
            // raw TFS server payload, which the TFS server may return in French —
            // match both languages so permission errors are still detected.
            if (
              lower.includes('permissions') ||
              lower.includes('access') ||
              lower.includes('accès') ||
              lower.includes('401') ||
              lower.includes('403')
            ) {
              result.hasPermissionErrors = true;
            }
          }
        }
      };

      const workers: Promise<void>[] = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Error while cleaning up the branches: ${message}`);
  }
}

const cleanBranchesTool: ToolDefinition = {
  name: 'tfs_cleanbranches',
  description:
    "Cleans up branches according to configurable criteria: excludes branches containing 'master', can keep branches with open PRs, recent branches, and the last N branches of config_kube repos",
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
      dryRun: {
        type: 'boolean',
        description:
          'Dry run mode (true) or actual deletion (false) - defaults to true',
      },
      configKubeBranchesToKeep: {
        type: 'integer',
        description: 'Number of config_kube branches to keep (defaults to 10)',
      },
      branchRetentionMonths: {
        type: 'integer',
        description: 'Branch retention period in months (defaults to 1)',
      },
      keepBranchesWithOpenPr: {
        type: 'boolean',
        description: 'Keep branches with open PRs (defaults to true)',
      },
    },
    required: ['project'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const dryRun = typeof args.dryRun === 'boolean' ? args.dryRun : true;
    let configKubeBranchesToKeep =
      typeof args.configKubeBranchesToKeep === 'number'
        ? args.configKubeBranchesToKeep
        : 10;
    let branchRetentionMonths =
      typeof args.branchRetentionMonths === 'number'
        ? args.branchRetentionMonths
        : 1;
    const keepBranchesWithOpenPr =
      typeof args.keepBranchesWithOpenPr === 'boolean'
        ? args.keepBranchesWithOpenPr
        : true;

    try {
      requireString(project, 'The project name');

      if (configKubeBranchesToKeep < 0) {
        configKubeBranchesToKeep = 10;
      }
      if (branchRetentionMonths < 0) {
        branchRetentionMonths = 1;
      }

      const result = await cleanBranches(
        client,
        project,
        dryRun,
        configKubeBranchesToKeep,
        branchRetentionMonths,
        keepBranchesWithOpenPr
      );

      const lines: string[] = [];
      lines.push(`🧹 **Branch cleanup - Project ${project}**\n`);
      lines.push(
        `🎯 **Mode:** ${dryRun ? '🔍 DRY RUN (no actual deletion)' : '⚠️ ACTUAL DELETION'}`
      );
      lines.push('');

      lines.push(`📊 **Statistics:**`);
      lines.push(`- 📂 **Total repositories:** ${result.totalRepositories}`);
      lines.push(`- ✅ **Eligible repositories:** ${result.eligibleRepositories}`);
      lines.push(
        `- ❌ **Excluded repositories:** ${result.skippedRepositories.length}`
      );
      lines.push(`- 🌿 **Identified branches:** ${result.totalBranches}`);
      if (keepBranchesWithOpenPr && result.skippedBranchesWithPr > 0) {
        lines.push(
          `- 🔗 **Excluded branches (open PR):** ${result.skippedBranchesWithPr}`
        );
      }
      if (result.skippedBranchesRecent > 0) {
        lines.push(
          `- 📅 **Excluded branches (updated < ${branchRetentionMonths} months ago):** ${result.skippedBranchesRecent}`
        );
      }

      if (!dryRun) {
        lines.push(`- 🗑️ **Deleted branches:** ${result.deletedBranches}`);
        lines.push(`- ⚠️ **Deletion failures:** ${result.failedDeletions}`);
      }
      lines.push('');

      if (result.skippedRepositories.length > 0) {
        lines.push(
          `🚫 **Excluded repositories (${result.skippedRepositories.length}):**`
        );
        for (const repo of result.skippedRepositories.slice(0, 10)) {
          lines.push(`  - ${repo}`);
        }
        if (result.skippedRepositories.length > 10) {
          lines.push(
            `  ... and ${result.skippedRepositories.length - 10} more`
          );
        }
        lines.push('');
      }

      if (
        keepBranchesWithOpenPr &&
        result.skippedBranchesWithPrList.length > 0
      ) {
        lines.push(
          `🔗 **Excluded branches with open PR (${result.skippedBranchesWithPrList.length}):**`
        );
        for (const branch of result.skippedBranchesWithPrList.slice(0, 20)) {
          lines.push(`  - 🔗 ${branch}`);
        }
        if (result.skippedBranchesWithPrList.length > 20) {
          lines.push(
            `  ... and ${result.skippedBranchesWithPrList.length - 20} more branches`
          );
        }
        lines.push('');
      }

      if (result.skippedBranchesRecentList.length > 0) {
        lines.push(
          `📅 **Excluded branches (updated < ${branchRetentionMonths} months ago) (${result.skippedBranchesRecentList.length}):**`
        );
        for (const branch of result.skippedBranchesRecentList.slice(0, 20)) {
          lines.push(`  - 📅 ${branch}`);
        }
        if (result.skippedBranchesRecentList.length > 20) {
          lines.push(
            `  ... and ${result.skippedBranchesRecentList.length - 20} more branches`
          );
        }
        lines.push('');
      }

      if (dryRun && result.deletedBranchesList.length > 0) {
        lines.push(
          `🔍 **Branches that would be deleted (${result.deletedBranchesList.length}):**`
        );
        for (const branch of result.deletedBranchesList.slice(0, 20)) {
          lines.push(`  - 🌿 ${branch}`);
        }
        if (result.deletedBranchesList.length > 20) {
          lines.push(
            `  ... and ${result.deletedBranchesList.length - 20} more branches`
          );
        }
        lines.push('');
        lines.push(
          `💡 **To perform the actual deletion, rerun with dryRun=false**`
        );
      } else if (!dryRun && result.deletedBranches > 0) {
        lines.push(
          `✅ **Branches deleted successfully (${result.deletedBranches}):**`
        );
        for (const branch of result.deletedBranchesList.slice(0, 20)) {
          lines.push(`  - 🗑️ ${branch}`);
        }
        if (result.deletedBranchesList.length > 20) {
          lines.push(
            `  ... and ${result.deletedBranchesList.length - 20} more branches`
          );
        }
        lines.push('');
      }

      if (!dryRun && result.failedBranchesList.length > 0) {
        lines.push(
          `⚠️ **Deletion failures (${result.failedBranchesList.length}):**`
        );
        for (const branch of result.failedBranchesList.slice(0, 10)) {
          lines.push(`  - ❌ ${branch}`);
        }
        if (result.failedBranchesList.length > 10) {
          lines.push(
            `  ... and ${result.failedBranchesList.length - 10} more`
          );
        }
        lines.push('');
      }

      if (!dryRun && result.hasPermissionErrors) {
        lines.push(`🔒 **⚠️ WARNING: Permission errors detected!**`);
        lines.push('');
        lines.push(
          `The permission errors indicate that you do not have the necessary rights to delete some branches.`
        );
        lines.push(
          `Make sure your Microsoft TFS account has the following permissions:`
        );
        lines.push(`  - **Force push** (contribute) on the repositories`);
        lines.push(`  - **Delete** on the branches`);
        lines.push(`  - **Manage permissions** if necessary`);
        lines.push('');
        lines.push(
          `💡 **Solution:** Contact your Microsoft TFS administrator to obtain the necessary permissions.`
        );
        lines.push('');
      }

      lines.push(`📋 **Applied criteria:**`);
      lines.push(`  - ❌ Excluded branches: contain 'master'`);
      if (keepBranchesWithOpenPr) {
        lines.push(`  - 🔗 Excluded branches: have an open pull request`);
      }
      lines.push(
        `  - 📅 Excluded branches: updated less than ${branchRetentionMonths} months ago`
      );
      lines.push(
        `  - 📦 config_kube repos: keep the last ${configKubeBranchesToKeep} branches (by update date)`
      );

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('cleaning up the branches', err, {
        Project: project,
        Mode: dryRun ? 'Dry run' : 'Actual deletion',
      });
    }
  },
};

export const branchTools: ToolDefinition[] = [cleanBranchesTool];
