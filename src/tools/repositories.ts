import type { ToolDefinition } from './types.js';
import type {
  TfsRepository,
  TfsRepositoriesResponse,
} from '../models/tfs.js';
import {
  formatErrorResponse,
  formatFileSize,
} from '../formatting/markdown.js';

function requireString(value: unknown, displayName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}

function projectPath(project: string, suffix: string): string {
  return `/${encodeURIComponent(project)}${suffix}`;
}

const searchRepositories: ToolDefinition = {
  name: 'tfs_searchrepositories',
  description:
    'Searches the Git repositories of a Microsoft TFS project by keywords (lightweight alternative to getrepositories)',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
      searchTerm: {
        type: 'string',
        description: 'Search term to filter the repositories (name)',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of results to return (default 10)',
      },
    },
    required: ['project'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const rawSearchTerm =
      typeof args.searchTerm === 'string' ? args.searchTerm : '';
    const rawMax =
      typeof args.maxResults === 'number' ? args.maxResults : 10;
    const maxResults = rawMax <= 0 || rawMax > 50 ? 10 : rawMax;

    try {
      requireString(project, 'The project name');

      const url = client.url(
        projectPath(project, '/_apis/git/repositories'),
        { 'api-version': '6.0' }
      );
      const response = await client.get<TfsRepositoriesResponse>(
        url,
        'searching the repositories'
      );
      const allRepositories: TfsRepository[] = response.value ?? [];

      let repositories: TfsRepository[];
      if (!rawSearchTerm.trim()) {
        repositories = allRepositories.slice(0, maxResults);
      } else {
        const needle = rawSearchTerm.toLowerCase();
        repositories = allRepositories
          .filter((r) => (r.name ?? '').toLowerCase().includes(needle))
          .slice(0, maxResults);
      }

      if (repositories.length === 0) {
        return rawSearchTerm.trim().length === 0
          ? `📂 **No repository found for project '${project}'**\n\n💡 **The project may not have any repositories configured**`
          : `🔍 **No repository found for '${rawSearchTerm}' in project '${project}'**\n\n💡 **Try different keywords or check the spelling**`;
      }

      const lines: string[] = [];
      const header = !rawSearchTerm.trim()
        ? `📂 **Repositories of project ${project} (first ${repositories.length} results)**`
        : `🔍 **Repositories found for '${rawSearchTerm}' in ${project} (${repositories.length} results)**`;
      lines.push(header);
      lines.push('');

      for (const repo of repositories) {
        lines.push('---');
        lines.push(`📋 **${repo.name ?? ''}** \`${repo.id ?? ''}\``);
        if (repo.defaultBranch) {
          lines.push(`🌿 Branch: ${repo.defaultBranch}`);
        }
        lines.push(`💾 Size: ${formatFileSize(repo.size)}`);
        if (repo.remoteUrl) {
          lines.push(`🌐 URL: ${repo.remoteUrl}`);
        }
        lines.push('');
      }

      if (repositories.length === maxResults) {
        lines.push(
          `💡 *Display limited to ${maxResults} results. Use more specific keywords to refine the search.*`
        );
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('searching the repositories', err, {
        project,
        searchTerm: rawSearchTerm,
        maxResults,
      });
    }
  },
};

const getRepositories: ToolDefinition = {
  name: 'tfs_getrepositories',
  description: 'Fetches the Git repositories of a Microsoft TFS project',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
    },
    required: ['project'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';

    try {
      requireString(project, 'The project name');

      const url = client.url(
        projectPath(project, '/_apis/git/repositories'),
        { 'api-version': '6.0' }
      );
      const response = await client.get<TfsRepositoriesResponse>(
        url,
        'fetching the repositories'
      );
      const repositories: TfsRepository[] = response.value ?? [];

      if (repositories.length === 0) {
        return `📂 **No repository found for project '${project}'**\n\n💡 **The project may not have any repositories configured**`;
      }

      const lines: string[] = [];
      lines.push(
        `📂 **Repositories of project ${project} (${repositories.length})**`
      );
      lines.push('');

      for (const repo of repositories) {
        lines.push('---');
        lines.push(`🔑 **ID:** ${repo.id ?? ''}`);
        lines.push(`📋 **Name:** ${repo.name ?? ''}`);
        if (repo.defaultBranch) {
          lines.push(`🌿 **Default branch:** ${repo.defaultBranch}`);
        }
        lines.push(`💾 **Size:** ${formatFileSize(repo.size)}`);
        if (repo.remoteUrl) {
          lines.push(`🌐 **Remote URL:** ${repo.remoteUrl}`);
        }
        lines.push(`🔗 **Link:** ${repo.url ?? ''}`);
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching the repositories', err, {
        Project: project,
      });
    }
  },
};

export const repositoryTools: ToolDefinition[] = [
  searchRepositories,
  getRepositories,
];
