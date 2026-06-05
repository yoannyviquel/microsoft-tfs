import { ICON } from './icons.js';
import type {
  TfsPullRequest,
  TfsPullRequestThreadStatusContainer,
  TfsWorkItem,
} from '../models/tfs.js';

export function formatErrorResponse(
  operation: string,
  error: unknown,
  requestDetails: Record<string, unknown> = {}
): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines: string[] = [];
  lines.push(`${ICON.error} **Error while ${operation}:**`);
  lines.push('');
  lines.push(`${ICON.warning} ${message}`);
  lines.push('');

  const entries = Object.entries(requestDetails);
  if (entries.length > 0) {
    lines.push(`${ICON.list} **Request details:**`);
    for (const [key, value] of entries) {
      lines.push(`- ${key}: ${value ?? 'Not specified'}`);
    }
  }
  return lines.join('\n');
}

const DATE_FORMATTER = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatFileSize(bytes: number | undefined | null): string {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  let len = value;
  let order = 0;
  while (len >= 1024 && order < sizes.length - 1) {
    order++;
    len /= 1024;
  }
  // Format "0.##" — up to 2 decimals, no trailing zeros (e.g. 1.5, 12, 12.34)
  const rounded = Math.round(len * 100) / 100;
  const formatted = Number.isInteger(rounded)
    ? rounded.toString()
    : rounded
        .toFixed(2)
        .replace(/\.?0+$/, '');
  return `${formatted} ${sizes[order]}`;
}

export function formatDate(iso: string | undefined | null): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = DATE_FORMATTER.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

export function formatWorkItemDetails(
  workItem: TfsWorkItem,
  includeDescription: boolean = false
): string {
  const fields = workItem.fields ?? {};
  const lines: string[] = [];
  lines.push(`${ICON.key} **ID:** ${workItem.id ?? ''}`);
  lines.push(`${ICON.list} **Title:** ${fields['System.Title'] ?? 'Untitled'}`);
  lines.push(`${ICON.state} **State:** ${fields['System.State'] ?? 'Unknown'}`);
  lines.push(`${ICON.tag} **Type:** ${fields['System.WorkItemType'] ?? 'Unknown'}`);

  if (fields['System.Priority'] !== undefined && fields['System.Priority'] !== null) {
    lines.push(`${ICON.bolt} **Priority:** ${fields['System.Priority']}`);
  }

  if (fields['System.AssignedTo']) {
    lines.push(`${ICON.user} **Assigned to:** ${fields['System.AssignedTo'].displayName ?? ''}`);
  }

  if (fields['System.CreatedBy']) {
    lines.push(`${ICON.edit} **Created by:** ${fields['System.CreatedBy'].displayName ?? ''}`);
  }

  const createdDate = formatDate(fields['System.CreatedDate']);
  if (createdDate) {
    lines.push(`${ICON.calendar} **Created on:** ${createdDate}`);
  }

  const changedDate = formatDate(fields['System.ChangedDate']);
  if (changedDate) {
    lines.push(`${ICON.refresh} **Modified on:** ${changedDate}`);
  }

  const description = fields['System.Description'];
  if (description) {
    if (includeDescription) {
      lines.push('');
      lines.push(`${ICON.edit} **Description:**`);
      lines.push(description);
    } else {
      const truncated =
        description.length > 100 ? description.substring(0, 100) + '...' : description;
      lines.push(`${ICON.edit} **Description:** ${truncated}`);
    }
  }

  if (workItem.url) {
    lines.push(`${ICON.link} **Link:** ${workItem.url}`);
  }

  return lines.join('\n') + '\n';
}

export function buildPullRequestUrl(
  project: string,
  repositoryName: string,
  pullRequestId: number
): string {
  const base = (process.env.TFS_BASE_URL?.trim() || 'http://tfs.example.com:8080/tfs').replace(/\/+$/, '');
  const org = process.env.TFS_ORG?.trim() || 'DefaultCollection';
  return `${base}/${org}/${project}/_git/${repositoryName}/pullrequest/${pullRequestId}`;
}

export function formatPullRequestThreadStatus(
  threadOrStatus:
    | TfsPullRequestThreadStatusContainer
    | number
    | string
    | null
    | undefined
): string {
  const status =
    typeof threadOrStatus === 'object' && threadOrStatus !== null
      ? threadOrStatus.status
      : threadOrStatus;

  if (typeof status === 'string') {
    return status.trim().length === 0 ? 'unknown' : status;
  }

  if (typeof status === 'number' && Number.isFinite(status)) {
    switch (status) {
      case 0:
        return 'unknown';
      case 1:
        return 'active';
      case 2:
        return 'fixed';
      case 3:
        return 'wontFix';
      case 4:
        return 'closed';
      case 5:
        return 'byDesign';
      case 6:
        return 'pending';
      default:
        return `numeric(${status})`;
    }
  }

  return 'unknown';
}

export function formatPullRequestDetails(
  pullRequest: TfsPullRequest,
  includeDescription: boolean = false
): string {
  const lines: string[] = [];
  lines.push(`${ICON.key} **ID:** ${pullRequest.pullRequestId ?? ''}`);
  lines.push(`${ICON.list} **Title:** ${pullRequest.title ?? ''}`);
  lines.push(`${ICON.state} **Status:** ${pullRequest.status ?? ''}`);
  lines.push(`${ICON.branchSource} **Source branch:** ${pullRequest.sourceRefName ?? ''}`);
  lines.push(`${ICON.branchTarget} **Target branch:** ${pullRequest.targetRefName ?? ''}`);

  if (pullRequest.createdBy) {
    lines.push(`${ICON.user} **Created by:** ${pullRequest.createdBy.displayName ?? ''}`);
  }

  const creationDate = formatDate(pullRequest.creationDate);
  if (creationDate) {
    lines.push(`${ICON.calendar} **Created on:** ${creationDate}`);
  }

  const closedDate = formatDate(pullRequest.closedDate);
  if (closedDate) {
    lines.push(`${ICON.flag} **Closed on:** ${closedDate}`);
  }

  if (pullRequest.closedBy) {
    lines.push(`${ICON.lock} **Closed by:** ${pullRequest.closedBy.displayName ?? ''}`);
  }

  if (pullRequest.isDraft === true) {
    lines.push(`${ICON.edit} **Draft:** Yes`);
  }

  if (pullRequest.mergeStatus && pullRequest.mergeStatus.length > 0) {
    lines.push(`${ICON.merge} **Merge status:** ${pullRequest.mergeStatus}`);
  }

  if (pullRequest.reviewers && pullRequest.reviewers.length > 0) {
    lines.push(`${ICON.reviewers} **Reviewers:** ${pullRequest.reviewers.length}`);
  }

  if (pullRequest.description && pullRequest.description.length > 0) {
    if (includeDescription) {
      lines.push('');
      lines.push(`${ICON.edit} **Description:**`);
      lines.push(pullRequest.description);
    } else {
      const truncated =
        pullRequest.description.length > 100
          ? pullRequest.description.substring(0, 100) + '...'
          : pullRequest.description;
      lines.push(`${ICON.edit} **Description:** ${truncated}`);
    }
  }

  if (pullRequest.url && pullRequest.url.length > 0) {
    const projectName = pullRequest.repository?.project?.name;
    const repoName = pullRequest.repository?.name;
    if (
      projectName &&
      projectName.length > 0 &&
      repoName &&
      repoName.length > 0 &&
      typeof pullRequest.pullRequestId === 'number'
    ) {
      const correctUrl = buildPullRequestUrl(projectName, repoName, pullRequest.pullRequestId);
      lines.push(`${ICON.link} **Link:** ${correctUrl}`);
    } else {
      lines.push(`${ICON.link} **Link:** ${pullRequest.url}`);
    }
  }

  return lines.join('\n') + '\n';
}
