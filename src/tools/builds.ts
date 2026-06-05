import type { ToolDefinition } from './types.js';
import type {
  TfsBuild,
  TfsBuildDefinition,
  TfsBuildDefinitionsResponse,
  TfsBuildsResponse,
  TfsQueueBuildRequest,
} from '../models/tfs.js';
import { formatErrorResponse, formatDate } from '../formatting/markdown.js';

function requireString(value: unknown, displayName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}

function requireInteger(value: unknown, displayName: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}

function projectPath(project: string, suffix: string): string {
  return `/${encodeURIComponent(project)}${suffix}`;
}

function parseBuildParameters(
  parametersJson: string | undefined
): Record<string, string> | undefined {
  if (!parametersJson || !parametersJson.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(parametersJson);
  } catch {
    throw new Error('The JSON format of the parameters is invalid');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error('The JSON format of the parameters is invalid');
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error('The JSON format of the parameters is invalid');
    }
    result[k] = v;
  }
  return result;
}

const getBuilds: ToolDefinition = {
  name: 'tfs_getbuilds',
  description: 'Fetches the builds of a Microsoft TFS project',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
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
    const maxResults =
      typeof args.maxResults === 'number' ? args.maxResults : 10;

    try {
      requireString(project, 'The project name');

      const url = client.url(projectPath(project, '/_apis/build/builds'), {
        $top: maxResults,
        'api-version': '6.0',
      });
      const response = await client.get<TfsBuildsResponse>(
        url,
        'fetching the builds'
      );
      const builds: TfsBuild[] = response.value ?? [];

      if (builds.length === 0) {
        return `🔨 **No build found for project '${project}'**\n\n💡 **The project may not have any builds configured**`;
      }

      const ordered = [...builds].sort((a, b) => {
        const at = a.startTime ? Date.parse(a.startTime) : 0;
        const bt = b.startTime ? Date.parse(b.startTime) : 0;
        return bt - at;
      });

      const lines: string[] = [];
      lines.push(`🔨 **Builds of project ${project} (${builds.length})**`);
      lines.push('');

      for (const build of ordered) {
        lines.push('---');
        lines.push(`🔑 **ID:** ${build.id ?? ''}`);
        lines.push(`📋 **Number:** ${build.buildNumber ?? ''}`);
        lines.push(`📊 **Status:** ${build.status ?? ''}`);
        lines.push(`🎯 **Result:** ${build.result ?? ''}`);
        const startedAt = formatDate(build.startTime);
        if (startedAt) {
          lines.push(`🕐 **Started on:** ${startedAt}`);
        }
        const finishedAt = formatDate(build.finishTime);
        if (finishedAt) {
          lines.push(`🏁 **Finished on:** ${finishedAt}`);
        }
        if (build.sourceBranch) {
          lines.push(`🌿 **Branch:** ${build.sourceBranch}`);
        }
        lines.push(`🔗 **Link:** ${build.url ?? ''}`);
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching the builds', err, {
        Project: project,
        'Maximum number of results': maxResults,
      });
    }
  },
};

const queueBuild: ToolDefinition = {
  name: 'tfs_queuebuild',
  description: 'Queues or re-queues a build pipeline on Microsoft TFS',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      definitionId: {
        type: 'integer',
        description: 'The ID of the build definition (pipeline)',
      },
      sourceBranch: {
        type: 'string',
        description: 'Source branch (optional, e.g. refs/heads/main)',
      },
      sourceVersion: {
        type: 'string',
        description: 'Source version / commit ID (optional)',
      },
      parametersJson: {
        type: 'string',
        description:
          'Build parameters in JSON format (optional, e.g. {"param1":"value1"})',
      },
    },
    required: ['project', 'definitionId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const definitionId =
      typeof args.definitionId === 'number' ? args.definitionId : NaN;
    const sourceBranch =
      typeof args.sourceBranch === 'string' ? args.sourceBranch : undefined;
    const sourceVersion =
      typeof args.sourceVersion === 'string' ? args.sourceVersion : undefined;
    const parametersJson =
      typeof args.parametersJson === 'string' ? args.parametersJson : undefined;

    try {
      requireString(project, 'The project name');
      requireInteger(definitionId, 'The build definition ID');

      const parameters = parseBuildParameters(parametersJson);

      const buildRequest: TfsQueueBuildRequest = {
        definition: { id: definitionId },
      };
      if (sourceBranch && sourceBranch.trim()) {
        buildRequest.sourceBranch = sourceBranch;
      }
      if (sourceVersion && sourceVersion.trim()) {
        buildRequest.sourceVersion = sourceVersion;
      }
      if (parameters && Object.keys(parameters).length > 0) {
        buildRequest.parameters = JSON.stringify(parameters);
      }

      const url = client.url(projectPath(project, '/_apis/build/builds'), {
        'api-version': '6.0',
      });

      const build = await client.request<TfsBuild>(
        'POST',
        url,
        buildRequest,
        { operationName: 'queuing the build' }
      );

      let result =
        `✅ **Build queued successfully!**\n\n` +
        `🆔 **ID:** ${build.id ?? ''}\n` +
        `📋 **Number:** ${build.buildNumber ?? ''}\n` +
        `📁 **Project:** ${project}\n` +
        `🔧 **Definition ID:** ${definitionId}\n` +
        `📊 **Status:** ${build.status ?? ''}\n`;
      if (build.sourceBranch) {
        result += `🌿 **Branch:** ${build.sourceBranch}\n`;
      }
      if (build.sourceVersion) {
        result += `📌 **Version:** ${build.sourceVersion}\n`;
      }
      const startedAt = formatDate(build.startTime);
      if (startedAt) {
        result += `🕐 **Started on:** ${startedAt}\n`;
      }
      result += `🔗 **Link:** ${build.url ?? ''}`;
      return result;
    } catch (err) {
      return formatErrorResponse('queuing the build', err, {
        Project: project,
        'Definition ID': Number.isFinite(definitionId) ? definitionId : '',
        Branch: sourceBranch ?? 'Default',
        Version: sourceVersion ?? 'Default',
        Parameters: parametersJson ?? 'None',
      });
    }
  },
};

const cancelBuild: ToolDefinition = {
  name: 'tfs_cancelbuild',
  description: 'Cancels a running or pending Microsoft TFS build',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
      },
      buildId: {
        type: 'integer',
        description: 'The ID of the build to cancel',
      },
    },
    required: ['project', 'buildId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const buildId = typeof args.buildId === 'number' ? args.buildId : NaN;

    try {
      requireString(project, 'The project name');
      requireInteger(buildId, 'The build ID');

      const url = client.url(
        projectPath(project, `/_apis/build/builds/${buildId}`),
        { 'api-version': '6.0' }
      );

      const build = await client.request<TfsBuild>(
        'PATCH',
        url,
        { status: 'cancelling' },
        { operationName: 'cancelling the build' }
      );

      return (
        `✅ **Build cancelled successfully!**\n\n` +
        `🆔 **ID:** ${build.id ?? ''}\n` +
        `📋 **Number:** ${build.buildNumber ?? ''}\n` +
        `📁 **Project:** ${project}\n` +
        `📊 **Status:** ${build.status ?? ''}\n` +
        `🔗 **Link:** ${build.url ?? ''}`
      );
    } catch (err) {
      return formatErrorResponse('cancelling the build', err, {
        Project: project,
        'Build ID': Number.isFinite(buildId) ? buildId : '',
      });
    }
  },
};

const getBuildDefinitions: ToolDefinition = {
  name: 'tfs_getbuilddefinitions',
  description:
    'Fetches the build definitions (pipelines) of a Microsoft TFS project',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The name of the Microsoft TFS project',
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
    const maxResults =
      typeof args.maxResults === 'number' ? args.maxResults : 50;

    try {
      requireString(project, 'The project name');

      const url = client.url(
        projectPath(project, '/_apis/build/definitions'),
        { $top: maxResults, 'api-version': '6.0' }
      );
      const response = await client.get<TfsBuildDefinitionsResponse>(
        url,
        'fetching the build definitions'
      );
      const definitions: TfsBuildDefinition[] = response.value ?? [];

      if (definitions.length === 0) {
        return `🔧 **No build definition found for project '${project}'**\n\n💡 **The project may not have any pipelines configured**`;
      }

      const ordered = [...definitions].sort((a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '')
      );

      const lines: string[] = [];
      lines.push(
        `🔧 **Build definitions of project ${project} (${definitions.length})**`
      );
      lines.push('');

      for (const definition of ordered) {
        lines.push('---');
        lines.push(`🔑 **ID:** ${definition.id ?? ''}`);
        lines.push(`📋 **Name:** ${definition.name ?? ''}`);
        if (definition.path) {
          lines.push(`📂 **Path:** ${definition.path}`);
        }
        lines.push(`🏷️ **Type:** ${definition.type ?? ''}`);
        lines.push(`📊 **Status:** ${definition.queueStatus ?? ''}`);
        if (definition.repository && definition.repository.name) {
          lines.push(`📦 **Repository:** ${definition.repository.name}`);
        }
        lines.push(`🔗 **Link:** ${definition.url ?? ''}`);
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse(
        'fetching the build definitions',
        err,
        {
          Project: project,
          'Maximum number of results': maxResults,
        }
      );
    }
  },
};

export const buildTools: ToolDefinition[] = [
  getBuilds,
  queueBuild,
  cancelBuild,
  getBuildDefinitions,
];
