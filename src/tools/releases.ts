import type { ToolDefinition } from './types.js';
import type {
  TfsCreateReleaseRequest,
  TfsRelease,
  TfsReleaseApproval,
  TfsReleaseApprovalsResponse,
  TfsReleaseDefinition,
  TfsReleaseDefinitionDetail,
  TfsReleaseDefinitionsResponse,
  TfsReleaseDeployment,
  TfsReleaseDeploymentsResponse,
  TfsReleaseEnvironment,
  TfsReleasesResponse,
  TfsUpdateReleaseApprovalRequest,
  TfsUpdateReleaseEnvironmentRequest,
  TfsUpdateReleaseRequest,
} from '../models/tfs.js';
import { formatErrorResponse, formatDate } from '../formatting/markdown.js';

function requireString(value: unknown, displayName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}

function projectPath(project: string, suffix: string): string {
  return `/${encodeURIComponent(project)}${suffix}`;
}

function environmentIcon(status: string): string {
  switch (status.toLowerCase()) {
    case 'succeeded':
      return '✅';
    case 'partiallysucceeded':
      return '⚠️';
    case 'failed':
    case 'rejected':
    case 'canceled':
      return '❌';
    case 'inprogress':
    case 'queued':
    case 'scheduled':
      return '⏳';
    case 'notdeployed':
      return '⏸️';
    default:
      return '•';
  }
}

function deploymentIcon(status: string): string {
  switch (status.toLowerCase()) {
    case 'succeeded':
      return '✅';
    case 'partiallysucceeded':
      return '⚠️';
    case 'failed':
      return '❌';
    case 'inprogress':
      return '⏳';
    default:
      return '•';
  }
}

const getReleaseDefinitions: ToolDefinition = {
  name: 'tfs_getreleasedefinitions',
  description:
    'Fetches the release definitions (deployment pipelines) of a Microsoft TFS project',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      searchText: {
        type: 'string',
        description: 'Search text to filter by name (optional)',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of results (default 50)',
      },
    },
    required: ['project'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const searchText =
      typeof args.searchText === 'string' ? args.searchText : undefined;
    const maxResults =
      typeof args.maxResults === 'number' ? args.maxResults : 50;

    try {
      requireString(project, 'The project name');

      const url = client.url(
        projectPath(project, '/_apis/release/definitions'),
        {
          $top: maxResults,
          'api-version': '5.1-preview.3',
          searchText:
            searchText && searchText.trim().length > 0 ? searchText : undefined,
        }
      );
      const response = await client.get<TfsReleaseDefinitionsResponse>(
        url,
        'fetching the release definitions'
      );
      const definitions: TfsReleaseDefinition[] = response.value ?? [];

      if (definitions.length === 0) {
        return `🚀 **No release definition found for project '${project}'**\n\n💡 **The project may not have any release pipelines configured**`;
      }

      const ordered = [...definitions].sort((a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '')
      );

      const lines: string[] = [];
      lines.push(
        `🚀 **Release definitions of project ${project} (${definitions.length})**`
      );
      lines.push('');

      for (const definition of ordered) {
        lines.push('---');
        lines.push(`🔑 **ID:** ${definition.id ?? ''}`);
        lines.push(`📋 **Name:** ${definition.name ?? ''}`);
        if (definition.path && definition.path !== '\\') {
          lines.push(`📂 **Path:** ${definition.path}`);
        }
        if (definition.releaseNameFormat) {
          lines.push(`🏷️ **Format:** ${definition.releaseNameFormat}`);
        }
        const modifiedOn = formatDate(definition.modifiedOn);
        if (modifiedOn) {
          lines.push(`🔄 **Modified on:** ${modifiedOn}`);
        }
        if (definition.url) {
          lines.push(`🔗 **Link:** ${definition.url}`);
        }
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse(
        'fetching the release definitions',
        err,
        {
          Project: project,
          'Search text': searchText ?? 'None',
          'Maximum number of results': maxResults,
        }
      );
    }
  },
};

const getReleases: ToolDefinition = {
  name: 'tfs_getreleases',
  description:
    'Fetches the releases of a Microsoft TFS project with their status per environment (useful to see which version is deployed where)',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      definitionId: {
        type: 'integer',
        description: 'Release definition ID to filter by (optional)',
      },
      statusFilter: {
        type: 'string',
        description: 'Release status filter: draft, active, abandoned (optional)',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of results (default 10)',
      },
    },
    required: ['project'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const definitionId =
      typeof args.definitionId === 'number' ? args.definitionId : undefined;
    const statusFilter =
      typeof args.statusFilter === 'string' ? args.statusFilter : undefined;
    const maxResults =
      typeof args.maxResults === 'number' ? args.maxResults : 10;

    try {
      requireString(project, 'The project name');

      const url = client.url(
        projectPath(project, '/_apis/release/releases'),
        {
          $top: maxResults,
          $expand: 'environments',
          'api-version': '5.1-preview.8',
          definitionId: definitionId,
          statusFilter:
            statusFilter && statusFilter.trim().length > 0
              ? statusFilter
              : undefined,
        }
      );
      const response = await client.get<TfsReleasesResponse>(
        url,
        'fetching the releases'
      );
      const releases: TfsRelease[] = response.value ?? [];

      if (releases.length === 0) {
        return `🚀 **No release found for project '${project}'**`;
      }

      const ordered = [...releases].sort((a, b) => {
        const at = a.createdOn ? Date.parse(a.createdOn) : 0;
        const bt = b.createdOn ? Date.parse(b.createdOn) : 0;
        return bt - at;
      });

      const lines: string[] = [];
      lines.push(`🚀 **Releases of project ${project} (${releases.length})**`);
      lines.push('');

      for (const release of ordered) {
        lines.push('---');
        lines.push(`🔑 **ID:** ${release.id ?? ''}`);
        lines.push(`📋 **Name:** ${release.name ?? ''}`);
        lines.push(`📊 **Status:** ${release.status ?? ''}`);
        if (release.releaseDefinition) {
          lines.push(
            `🔧 **Pipeline:** ${release.releaseDefinition.name ?? ''} (ID ${release.releaseDefinition.id ?? ''})`
          );
        }
        const createdOn = formatDate(release.createdOn);
        if (createdOn) {
          lines.push(`📅 **Created on:** ${createdOn}`);
        }
        if (release.createdBy) {
          lines.push(`👤 **Created by:** ${release.createdBy.displayName ?? ''}`);
        }

        const environments: TfsReleaseEnvironment[] =
          release.environments ?? [];
        if (environments.length > 0) {
          lines.push(`🌍 **Environments:**`);
          for (const env of environments) {
            const deployStatus =
              env.deploymentStatus && env.deploymentStatus.length > 0
                ? env.deploymentStatus
                : env.status ?? '';
            const icon = environmentIcon(deployStatus);
            lines.push(`   ${icon} ${env.name ?? ''}: ${deployStatus}`);
          }
        }

        if (release.url) {
          lines.push(`🔗 **Link:** ${release.url}`);
        }
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching the releases', err, {
        Project: project,
        'Definition ID':
          definitionId !== undefined ? String(definitionId) : 'All',
        'Status filter': statusFilter ?? 'None',
        'Maximum number of results': maxResults,
      });
    }
  },
};

const getDeployments: ToolDefinition = {
  name: 'tfs_getdeployments',
  description:
    "Fetches the deployments of a Microsoft TFS project. Helps answer 'which version is in prod?' by filtering by environment and succeeded status.",
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      definitionId: {
        type: 'integer',
        description: 'Release definition ID to filter by (optional)',
      },
      environmentName: {
        type: 'string',
        description:
          "Environment name to filter by (e.g. 'prod', 'recette') - client-side filtering (optional)",
      },
      deploymentStatus: {
        type: 'string',
        description:
          'Status filter: succeeded, failed, partiallySucceeded, inProgress, all (optional)',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of results (default 10)',
      },
    },
    required: ['project'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const definitionId =
      typeof args.definitionId === 'number' ? args.definitionId : undefined;
    const environmentName =
      typeof args.environmentName === 'string' ? args.environmentName : undefined;
    const deploymentStatus =
      typeof args.deploymentStatus === 'string'
        ? args.deploymentStatus
        : undefined;
    const maxResults =
      typeof args.maxResults === 'number' ? args.maxResults : 10;

    try {
      requireString(project, 'The project name');

      const url = client.url(
        projectPath(project, '/_apis/release/deployments'),
        {
          $top: maxResults,
          'api-version': '5.1-preview.2',
          definitionId: definitionId,
          deploymentStatus:
            deploymentStatus && deploymentStatus.trim().length > 0
              ? deploymentStatus
              : undefined,
        }
      );
      const response = await client.get<TfsReleaseDeploymentsResponse>(
        url,
        'fetching the deployments'
      );
      let deployments: TfsReleaseDeployment[] = response.value ?? [];

      if (environmentName && environmentName.trim().length > 0) {
        const target = environmentName.toLowerCase();
        deployments = deployments.filter(
          (d) =>
            d.releaseEnvironment != null &&
            (d.releaseEnvironment.name ?? '').toLowerCase() === target
        );
      }

      if (deployments.length === 0) {
        const suffix =
          environmentName && environmentName.length > 0
            ? ` on environment '${environmentName}'`
            : '';
        return `📦 **No deployment found for project '${project}'**${suffix}`;
      }

      const ordered = [...deployments].sort((a, b) => {
        const at = Date.parse(
          a.completedOn ?? a.startedOn ?? a.queuedOn ?? ''
        );
        const bt = Date.parse(
          b.completedOn ?? b.startedOn ?? b.queuedOn ?? ''
        );
        const aVal = Number.isNaN(at) ? 0 : at;
        const bVal = Number.isNaN(bt) ? 0 : bt;
        return bVal - aVal;
      });

      const lines: string[] = [];
      lines.push(
        `📦 **Deployments of project ${project} (${deployments.length})**`
      );
      lines.push('');

      for (const deploy of ordered) {
        const icon = deploymentIcon(deploy.deploymentStatus ?? '');
        lines.push('---');
        lines.push(`${icon} **Deployment ID:** ${deploy.id ?? ''}`);
        if (deploy.release) {
          lines.push(
            `🚀 **Release:** ${deploy.release.name ?? ''} (ID ${deploy.release.id ?? ''})`
          );
        }
        if (deploy.releaseDefinition) {
          lines.push(
            `🔧 **Pipeline:** ${deploy.releaseDefinition.name ?? ''} (ID ${deploy.releaseDefinition.id ?? ''})`
          );
        }
        if (deploy.releaseEnvironment) {
          lines.push(
            `🌍 **Environment:** ${deploy.releaseEnvironment.name ?? ''}`
          );
        }
        lines.push(`📊 **Status:** ${deploy.deploymentStatus ?? ''}`);
        if (deploy.operationStatus) {
          lines.push(`⚙️ **Operation:** ${deploy.operationStatus}`);
        }
        if (deploy.reason) {
          lines.push(`💡 **Reason:** ${deploy.reason}`);
        }
        if (deploy.attempt !== undefined && deploy.attempt > 0) {
          lines.push(`🔁 **Attempt:** ${deploy.attempt}`);
        }
        const queuedOn = formatDate(deploy.queuedOn);
        if (queuedOn) {
          lines.push(`📅 **Queued on:** ${queuedOn}`);
        }
        const startedOn = formatDate(deploy.startedOn);
        if (startedOn) {
          lines.push(`🕐 **Started on:** ${startedOn}`);
        }
        const completedOn = formatDate(deploy.completedOn);
        if (completedOn) {
          lines.push(`🏁 **Completed on:** ${completedOn}`);
        }
        if (deploy.requestedFor) {
          lines.push(
            `👤 **Requested for:** ${deploy.requestedFor.displayName ?? ''}`
          );
        }
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching the deployments', err, {
        Project: project,
        'Definition ID':
          definitionId !== undefined ? String(definitionId) : 'All',
        Environment: environmentName ?? 'All',
        Status: deploymentStatus ?? 'All',
        'Maximum number of results': maxResults,
      });
    }
  },
};

const deployRelease: ToolDefinition = {
  name: 'tfs_deployrelease',
  description:
    "Deploys (or redeploys) a Microsoft TFS release to a given environment, e.g. preprod, recette, prod. Triggers the stage deployment by setting its status to 'inProgress'. Identify the environment by its name (environmentName) or its ID (environmentId).",
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      releaseId: {
        type: 'integer',
        description: 'The ID of the release to deploy',
      },
      environmentName: {
        type: 'string',
        description:
          "Name of the target environment (e.g. 'preprod', 'recette', 'prod'). Required if environmentId is absent. Case-insensitive.",
      },
      environmentId: {
        type: 'integer',
        description:
          'ID of the target environment. Required if environmentName is absent (takes precedence if both are provided).',
      },
      comment: {
        type: 'string',
        description: 'Comment associated with the deployment (optional)',
      },
    },
    required: ['project', 'releaseId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const releaseId =
      typeof args.releaseId === 'number' ? args.releaseId : NaN;
    const environmentName =
      typeof args.environmentName === 'string' ? args.environmentName : undefined;
    const environmentId =
      typeof args.environmentId === 'number' ? args.environmentId : undefined;
    const comment = typeof args.comment === 'string' ? args.comment : undefined;

    try {
      requireString(project, 'The project name');
      if (!Number.isInteger(releaseId)) {
        throw new Error('The release ID is required');
      }
      if (environmentId === undefined && !environmentName) {
        throw new Error(
          'The target environment is required (provide environmentName or environmentId)'
        );
      }

      // Fetch the release to resolve the environment (and list the choices in case of error)
      const releaseUrl = client.url(
        projectPath(project, `/_apis/release/releases/${releaseId}`),
        { 'api-version': '5.1-preview.8' }
      );
      const release = await client.get<TfsRelease>(
        releaseUrl,
        'fetching the release'
      );
      const environments: TfsReleaseEnvironment[] =
        release.environments ?? [];

      let target: TfsReleaseEnvironment | undefined;
      if (environmentId !== undefined) {
        target = environments.find((e) => e.id === environmentId);
      } else if (environmentName) {
        const needle = environmentName.toLowerCase();
        target = environments.find(
          (e) => (e.name ?? '').toLowerCase() === needle
        );
      }

      if (!target || target.id === undefined) {
        const available =
          environments.length > 0
            ? environments
                .map((e) => `${e.name ?? '?'} (ID ${e.id ?? '?'})`)
                .join(', ')
            : 'none';
        const wanted =
          environmentId !== undefined
            ? `ID ${environmentId}`
            : `'${environmentName}'`;
        throw new Error(
          `Environment ${wanted} not found on release ${releaseId}. Available environments: ${available}`
        );
      }

      const updateRequest: TfsUpdateReleaseEnvironmentRequest = {
        status: 'inProgress',
      };
      if (comment && comment.trim()) {
        updateRequest.comment = comment;
      }

      const deployUrl = client.url(
        projectPath(
          project,
          `/_apis/release/releases/${releaseId}/environments/${target.id}`
        ),
        { 'api-version': '5.1-preview.6' }
      );

      const updated = await client.request<TfsReleaseEnvironment>(
        'PATCH',
        deployUrl,
        updateRequest,
        { operationName: 'deploying the release' }
      );

      const status = updated.status ?? updated.deploymentStatus ?? 'inProgress';
      let result =
        `🚀 **Deployment triggered successfully!**\n\n` +
        `📁 **Project:** ${project}\n` +
        `🆔 **Release:** ${release.name ?? releaseId} (ID ${releaseId})\n` +
        `🌍 **Environment:** ${target.name ?? ''} (ID ${target.id})\n` +
        `📊 **Status:** ${status}\n`;
      if (comment && comment.trim()) {
        result += `💬 **Comment:** ${comment}\n`;
      }
      if (release.url) {
        result += `🔗 **Release link:** ${release.url}\n`;
      }
      result +=
        `\n💡 Track progress with \`tfs_getreleases\` or \`tfs_getdeployments\`.`;
      return result;
    } catch (err) {
      return formatErrorResponse('deploying the release', err, {
        Project: project,
        'Release ID': Number.isInteger(releaseId) ? releaseId : '',
        Environment: environmentName ?? 'None',
        'Environment ID':
          environmentId !== undefined ? String(environmentId) : 'None',
        Comment: comment ?? 'None',
      });
    }
  },
};

function approvalIcon(status: string): string {
  switch (status.toLowerCase()) {
    case 'approved':
      return '✅';
    case 'rejected':
      return '❌';
    case 'pending':
      return '⏳';
    case 'reassigned':
      return '🔁';
    case 'canceled':
      return '🚫';
    default:
      return '•';
  }
}

const getReleaseApprovals: ToolDefinition = {
  name: 'tfs_getreleaseapprovals',
  description:
    'Fetches Microsoft TFS release approvals (pre/post-deployment approval gates). By default lists pending ones to find out which deployment is blocked on an approval. Filterable by release.',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      releaseId: {
        type: 'integer',
        description: 'Release ID to filter the approvals (optional)',
      },
      statusFilter: {
        type: 'string',
        description:
          'Status filter: pending, approved, rejected, reassigned, canceled, all (default pending)',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of results (default 25)',
      },
    },
    required: ['project'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const releaseId =
      typeof args.releaseId === 'number' ? args.releaseId : undefined;
    const statusFilter =
      typeof args.statusFilter === 'string' && args.statusFilter.trim().length > 0
        ? args.statusFilter
        : 'pending';
    const maxResults =
      typeof args.maxResults === 'number' ? args.maxResults : 25;

    try {
      requireString(project, 'The project name');

      const url = client.url(
        projectPath(project, '/_apis/release/approvals'),
        {
          $top: maxResults,
          'api-version': '5.1-preview.3',
          statusFilter: statusFilter.toLowerCase() === 'all' ? undefined : statusFilter,
          releaseIdsFilter: releaseId,
        }
      );
      const response = await client.get<TfsReleaseApprovalsResponse>(
        url,
        'fetching the release approvals'
      );
      const approvals: TfsReleaseApproval[] = response.value ?? [];

      if (approvals.length === 0) {
        const suffix =
          releaseId !== undefined ? ` on release ${releaseId}` : '';
        return `🔏 **No '${statusFilter}' approval found for project '${project}'**${suffix}`;
      }

      const lines: string[] = [];
      lines.push(
        `🔏 **Release approvals of project ${project} (${approvals.length})**`
      );
      lines.push('');

      for (const approval of approvals) {
        const icon = approvalIcon(approval.status ?? '');
        lines.push('---');
        lines.push(`${icon} **Approval ID:** ${approval.id ?? ''}`);
        lines.push(`📊 **Status:** ${approval.status ?? ''}`);
        if (approval.approvalType) {
          lines.push(`🏷️ **Type:** ${approval.approvalType}`);
        }
        if (approval.release) {
          lines.push(
            `🚀 **Release:** ${approval.release.name ?? ''} (ID ${approval.release.id ?? ''})`
          );
        }
        if (approval.releaseEnvironment) {
          lines.push(
            `🌍 **Environment:** ${approval.releaseEnvironment.name ?? ''} (ID ${approval.releaseEnvironment.id ?? ''})`
          );
        }
        if (approval.approver) {
          lines.push(
            `👤 **Assigned to:** ${approval.approver.displayName ?? approval.approver.uniqueName ?? ''}`
          );
        }
        const createdOn = formatDate(approval.createdOn);
        if (createdOn) {
          lines.push(`📅 **Created on:** ${createdOn}`);
        }
        if (approval.comments) {
          lines.push(`💬 **Comment:** ${approval.comments}`);
        }
        lines.push('');
      }

      lines.push(
        `💡 Approve or reject with \`tfs_approverelease\` by passing the **Approval ID**.`
      );
      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse(
        'fetching the release approvals',
        err,
        {
          Project: project,
          'Release ID': releaseId !== undefined ? String(releaseId) : 'All',
          'Status filter': statusFilter,
          'Maximum number of results': maxResults,
        }
      );
    }
  },
};

const approveRelease: ToolDefinition = {
  name: 'tfs_approverelease',
  description:
    'Approves or rejects a Microsoft TFS release approval (pre/post-deployment approval gate). Unblocks (approved) or stops (rejected) the deployment of a pending stage. Get the approvalId via tfs_getreleaseapprovals.',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      approvalId: {
        type: 'integer',
        description:
          'The ID of the approval to process (obtained via tfs_getreleaseapprovals)',
      },
      status: {
        type: 'string',
        description:
          "Decision: 'approved' to approve, 'rejected' to reject (default 'approved')",
      },
      comment: {
        type: 'string',
        description: 'Comment associated with the decision (optional)',
      },
    },
    required: ['project', 'approvalId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const approvalId =
      typeof args.approvalId === 'number' ? args.approvalId : NaN;
    const rawStatus =
      typeof args.status === 'string' && args.status.trim().length > 0
        ? args.status.trim().toLowerCase()
        : 'approved';
    const comment = typeof args.comment === 'string' ? args.comment : undefined;

    try {
      requireString(project, 'The project name');
      if (!Number.isInteger(approvalId)) {
        throw new Error('The approval ID is required');
      }
      if (rawStatus !== 'approved' && rawStatus !== 'rejected') {
        throw new Error(
          `Invalid status '${rawStatus}'. Accepted values: 'approved' or 'rejected'`
        );
      }

      const updateRequest: TfsUpdateReleaseApprovalRequest = {
        status: rawStatus,
      };
      if (comment && comment.trim()) {
        updateRequest.comments = comment;
      }

      const approvalUrl = client.url(
        projectPath(project, `/_apis/release/approvals/${approvalId}`),
        { 'api-version': '5.1-preview.3' }
      );

      const updated = await client.request<TfsReleaseApproval>(
        'PATCH',
        approvalUrl,
        updateRequest,
        { operationName: 'processing the release approval' }
      );

      const verb = rawStatus === 'approved' ? 'approved' : 'rejected';
      const icon = rawStatus === 'approved' ? '✅' : '❌';
      let result =
        `${icon} **Approval ${verb} successfully!**\n\n` +
        `📁 **Project:** ${project}\n` +
        `🔑 **Approval ID:** ${approvalId}\n` +
        `📊 **Status:** ${updated.status ?? rawStatus}\n`;
      if (updated.release) {
        result += `🚀 **Release:** ${updated.release.name ?? ''} (ID ${updated.release.id ?? ''})\n`;
      }
      if (updated.releaseEnvironment) {
        result += `🌍 **Environment:** ${updated.releaseEnvironment.name ?? ''}\n`;
      }
      if (updated.approvedBy) {
        result += `👤 **Processed by:** ${updated.approvedBy.displayName ?? ''}\n`;
      }
      if (comment && comment.trim()) {
        result += `💬 **Comment:** ${comment}\n`;
      }
      result +=
        `\n💡 Track the deployment progress with \`tfs_getreleases\` or \`tfs_getdeployments\`.`;
      return result;
    } catch (err) {
      return formatErrorResponse(
        'processing the release approval',
        err,
        {
          Project: project,
          'Approval ID': Number.isInteger(approvalId) ? approvalId : '',
          Decision: rawStatus,
          Comment: comment ?? 'None',
        }
      );
    }
  },
};

const abandonRelease: ToolDefinition = {
  name: 'tfs_abandonrelease',
  description:
    "Abandons a Microsoft TFS release (sets its status to 'abandoned'). Useful to cancel a release that introduces a regression. An explanatory comment is required. Get the releaseId via tfs_getreleases.",
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      releaseId: {
        type: 'integer',
        description: 'The ID of the release to abandon',
      },
      comment: {
        type: 'string',
        description: 'Comment explaining the abandonment (required)',
      },
    },
    required: ['project', 'releaseId', 'comment'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const releaseId =
      typeof args.releaseId === 'number' ? args.releaseId : NaN;
    const comment = typeof args.comment === 'string' ? args.comment : '';

    try {
      requireString(project, 'The project name');
      if (!Number.isInteger(releaseId)) {
        throw new Error('The release ID is required');
      }
      requireString(comment, 'The abandonment comment');

      const updateRequest: TfsUpdateReleaseRequest = {
        status: 'abandoned',
        comment: comment,
      };

      const releaseUrl = client.url(
        projectPath(project, `/_apis/release/releases/${releaseId}`),
        { 'api-version': '5.1-preview.8', $expand: 'environments' }
      );

      const updated = await client.request<TfsRelease>(
        'PATCH',
        releaseUrl,
        updateRequest,
        { operationName: 'abandoning the release' }
      );

      const finalStatus = (updated.status ?? '').toLowerCase();
      if (finalStatus !== 'abandoned') {
        const deployed = (updated.environments ?? [])
          .filter((e) => {
            const s = (e.deploymentStatus || e.status || '').toLowerCase();
            return s === 'succeeded' || s === 'inprogress' || s === 'partiallysucceeded';
          })
          .map((e) => e.name ?? '?');
        const envSuffix =
          deployed.length > 0
            ? ` Environment(s) still deployed: ${deployed.join(', ')}.`
            : '';
        throw new Error(
          `The abandonment did not take effect: release ${releaseId} is still in status '${updated.status ?? 'unknown'}'.${envSuffix} ` +
            `Abandoning a release does not unpublish an already deployed environment — ` +
            `redeploy the previous version (tfs_deployrelease) or cancel the affected stage.`
        );
      }

      let result =
        `🚫 **Release abandoned successfully!**\n\n` +
        `📁 **Project:** ${project}\n` +
        `🆔 **Release:** ${updated.name ?? releaseId} (ID ${releaseId})\n` +
        `📊 **Status:** ${updated.status ?? 'abandoned'}\n` +
        `💬 **Comment:** ${comment}\n`;
      if (updated.url) {
        result += `🔗 **Release link:** ${updated.url}\n`;
      }
      return result;
    } catch (err) {
      return formatErrorResponse('abandoning the release', err, {
        Project: project,
        'Release ID': Number.isInteger(releaseId) ? releaseId : '',
        Comment: comment || 'None',
      });
    }
  },
};

const getReleaseDefinition: ToolDefinition = {
  name: 'tfs_getreleasedefinition',
  description:
    'Fetches the detail of a single Microsoft TFS release definition (deployment pipeline) by ID. Exposes its artifact aliases and environment names — useful to prepare a tfs_createrelease (which alias / which environments to set manual).',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      definitionId: {
        type: 'integer',
        description: 'The ID of the release definition',
      },
    },
    required: ['project', 'definitionId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const definitionId =
      typeof args.definitionId === 'number' ? args.definitionId : NaN;

    try {
      requireString(project, 'The project name');
      if (!Number.isInteger(definitionId)) {
        throw new Error('The release definition ID is required');
      }

      const url = client.url(
        projectPath(project, `/_apis/release/definitions/${definitionId}`),
        { 'api-version': '5.1-preview.3' }
      );
      const definition = await client.get<TfsReleaseDefinitionDetail>(
        url,
        'fetching the release definition'
      );

      const lines: string[] = [];
      lines.push(
        `🚀 **Release definition ${definition.name ?? definitionId} (ID ${definition.id ?? definitionId})**`
      );
      lines.push('');
      if (definition.path && definition.path !== '\\') {
        lines.push(`📂 **Path:** ${definition.path}`);
      }
      if (definition.releaseNameFormat) {
        lines.push(`🏷️ **Format:** ${definition.releaseNameFormat}`);
      }

      const artifacts = definition.artifacts ?? [];
      if (artifacts.length > 0) {
        lines.push('');
        lines.push(`📦 **Artifacts:**`);
        for (const a of artifacts) {
          const primary = a.isPrimary ? ' (primary)' : '';
          lines.push(`   • ${a.alias ?? '?'} [${a.type ?? '?'}]${primary}`);
        }
      }

      const environments = definition.environments ?? [];
      if (environments.length > 0) {
        const ordered = [...environments].sort(
          (a, b) => (a.rank ?? 0) - (b.rank ?? 0)
        );
        lines.push('');
        lines.push(`🌍 **Environments:**`);
        for (const e of ordered) {
          lines.push(`   • ${e.name ?? '?'} (ID ${e.id ?? '?'})`);
        }
      }

      if (definition.url) {
        lines.push('');
        lines.push(`🔗 **Link:** ${definition.url}`);
      }
      lines.push('');
      lines.push(
        `💡 Create a release from a build with \`tfs_createrelease\` (definitionId ${definition.id ?? definitionId}).`
      );
      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching the release definition', err, {
        Project: project,
        'Definition ID': Number.isInteger(definitionId) ? definitionId : '',
      });
    }
  },
};

const createRelease: ToolDefinition = {
  name: 'tfs_createrelease',
  description:
    "Creates a release of a Microsoft TFS release definition (deployment pipeline) from a build, then leaves the configured environments to deploy. Use this when a branch build did not trigger the CD pipeline automatically (branch filter) so no release exists yet. Get the definitionId via tfs_getreleasedefinitions and the buildId via tfs_getbuilds. The build is wired as the release artifact (instanceReference.id).",
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      definitionId: {
        type: 'integer',
        description: 'The ID of the release definition (pipeline) to create a release of',
      },
      buildId: {
        type: ['integer', 'string'],
        description:
          'The build to use as the release artifact (its ID becomes artifacts[].instanceReference.id)',
      },
      artifactAlias: {
        type: 'string',
        description:
          "Alias of the artifact to set the build on (optional). If omitted, it is resolved from the definition: the artifact with isPrimary === true, otherwise the first one.",
      },
      description: {
        type: 'string',
        description: 'Release description / release notes (optional)',
      },
      isDraft: {
        type: 'boolean',
        description: 'Create the release as a draft (no automatic deployment). Default false.',
      },
      manualEnvironments: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Names of environments to NOT deploy automatically (set to manual), e.g. ["Prod_BDX","Prod_PAR"] (optional)',
      },
    },
    required: ['project', 'definitionId', 'buildId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const definitionId =
      typeof args.definitionId === 'number' ? args.definitionId : NaN;
    const buildId =
      typeof args.buildId === 'number'
        ? String(args.buildId)
        : typeof args.buildId === 'string'
          ? args.buildId
          : '';
    let artifactAlias =
      typeof args.artifactAlias === 'string' && args.artifactAlias.trim().length > 0
        ? args.artifactAlias.trim()
        : undefined;
    const description =
      typeof args.description === 'string' ? args.description : undefined;
    const isDraft = typeof args.isDraft === 'boolean' ? args.isDraft : false;
    const manualEnvironments = Array.isArray(args.manualEnvironments)
      ? args.manualEnvironments.filter(
          (e): e is string => typeof e === 'string' && e.trim().length > 0
        )
      : [];

    try {
      requireString(project, 'The project name');
      if (!Number.isInteger(definitionId)) {
        throw new Error('The release definition ID is required');
      }
      if (!buildId || buildId.trim().length === 0) {
        throw new Error('The build ID is required');
      }

      // Resolve the artifact alias from the definition when not provided.
      // Choice: the artifact flagged isPrimary === true, otherwise the first one.
      if (!artifactAlias) {
        const defUrl = client.url(
          projectPath(project, `/_apis/release/definitions/${definitionId}`),
          { 'api-version': '5.1-preview.3' }
        );
        const definition = await client.get<TfsReleaseDefinitionDetail>(
          defUrl,
          'resolving the artifact alias'
        );
        const artifacts = definition.artifacts ?? [];
        if (artifacts.length === 0) {
          throw new Error(
            `Release definition ${definitionId} has no artifact — provide artifactAlias explicitly`
          );
        }
        const chosen =
          artifacts.find((a) => a.isPrimary === true) ?? artifacts[0];
        artifactAlias = chosen.alias;
        if (!artifactAlias) {
          throw new Error(
            `Unable to resolve the artifact alias on definition ${definitionId} — provide artifactAlias explicitly`
          );
        }
      }

      const createRequest: TfsCreateReleaseRequest = {
        definitionId,
        isDraft,
        artifacts: [
          { alias: artifactAlias, instanceReference: { id: buildId } },
        ],
      };
      if (description && description.trim()) {
        createRequest.description = description;
      }
      if (manualEnvironments.length > 0) {
        createRequest.manualEnvironments = manualEnvironments;
      }

      const url = client.url(projectPath(project, '/_apis/release/releases'), {
        'api-version': '6.0',
      });

      const release = await client.request<TfsRelease>(
        'POST',
        url,
        createRequest,
        { operationName: 'creating the release' }
      );

      const webLink = release._links?.web?.href ?? release.url ?? '';

      let result =
        `🚀 **Release created successfully!**\n\n` +
        `📁 **Project:** ${project}\n` +
        `🆔 **Release:** ${release.name ?? ''} (ID ${release.id ?? ''})\n` +
        `🔧 **Definition ID:** ${definitionId}\n` +
        `📦 **Artifact:** ${artifactAlias} → build ${buildId}\n` +
        `📊 **Status:** ${release.status ?? (isDraft ? 'draft' : '')}\n`;
      if (description && description.trim()) {
        result += `📝 **Description:** ${description}\n`;
      }

      const environments: TfsReleaseEnvironment[] = release.environments ?? [];
      if (environments.length > 0) {
        result += `🌍 **Environments:**\n`;
        for (const env of environments) {
          const deployStatus =
            env.deploymentStatus && env.deploymentStatus.length > 0
              ? env.deploymentStatus
              : env.status ?? '';
          const icon = environmentIcon(deployStatus);
          result += `   ${icon} ${env.name ?? ''}: ${deployStatus}\n`;
        }
      }
      if (manualEnvironments.length > 0) {
        result += `✋ **Manual (not auto-deployed):** ${manualEnvironments.join(', ')}\n`;
      }
      if (webLink) {
        result += `🔗 **Link:** ${webLink}\n`;
      }
      result +=
        `\n💡 Deploy a manual stage with \`tfs_deployrelease\`, or track it with \`tfs_getreleases\`.`;
      return result;
    } catch (err) {
      return formatErrorResponse('creating the release', err, {
        Project: project,
        'Definition ID': Number.isInteger(definitionId) ? definitionId : '',
        'Build ID': buildId || '',
        'Artifact alias': artifactAlias ?? 'Auto (primary)',
        Draft: isDraft,
        'Manual environments':
          manualEnvironments.length > 0 ? manualEnvironments.join(', ') : 'None',
      });
    }
  },
};

export const releaseTools: ToolDefinition[] = [
  getReleaseDefinitions,
  getReleaseDefinition,
  getReleases,
  getDeployments,
  deployRelease,
  getReleaseApprovals,
  approveRelease,
  abandonRelease,
  createRelease,
];
