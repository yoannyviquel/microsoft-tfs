import type { ToolDefinition } from './types.js';
import type {
  TfsProject,
  TfsProjectsResponse,
} from '../models/tfs.js';
import { formatErrorResponse, formatDate } from '../formatting/markdown.js';

function formatDateShort(iso: string | undefined): string | undefined {
  const formatted = formatDate(iso);
  if (!formatted) return undefined;
  // Strip the time portion (after the space) to produce a "dd/MM/yyyy" form
  // matching the .NET `:dd/MM/yyyy` formatter used in searchprojects.
  const spaceIdx = formatted.indexOf(' ');
  return spaceIdx >= 0 ? formatted.substring(0, spaceIdx) : formatted;
}

const getProjects: ToolDefinition = {
  name: 'tfs_getprojects',
  description: 'Fetches all accessible Microsoft TFS projects',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, { client }) => {
    try {
      const url = client.url('/_apis/projects', { 'api-version': '6.0' });
      const response = await client.get<TfsProjectsResponse>(
        url,
        'fetching projects'
      );
      const projects: TfsProject[] = response.value ?? [];

      if (projects.length === 0) {
        return "📁 **No project found**\n\n💡 **You may not have access to any projects or no project is configured**";
      }

      const lines: string[] = [];
      lines.push(`📁 **Available Microsoft TFS projects (${projects.length})**`);
      lines.push('');

      for (const project of projects) {
        lines.push('---');
        lines.push(`🔑 **ID:** ${project.id ?? ''}`);
        lines.push(`📋 **Name:** ${project.name ?? ''}`);
        if (project.description) {
          lines.push(`📝 **Description:** ${project.description}`);
        }
        lines.push(`📊 **State:** ${project.state ?? ''}`);
        lines.push(`👁️ **Visibility:** ${project.visibility ?? ''}`);
        const updated = formatDate(project.lastUpdateTime);
        if (updated) {
          lines.push(`🔄 **Last updated:** ${updated}`);
        }
        lines.push(`🔗 **URL:** ${project.url ?? ''}`);
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching projects', err, {});
    }
  },
};

const searchProjects: ToolDefinition = {
  name: 'tfs_searchprojects',
  description:
    'Searches Microsoft TFS projects by keywords (lightweight alternative to getprojects)',
  inputSchema: {
    type: 'object',
    properties: {
      searchTerm: {
        type: 'string',
        description: 'Search term to filter projects (name or description)',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of results to return (default 10)',
      },
    },
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const rawSearchTerm = typeof args.searchTerm === 'string' ? args.searchTerm : '';
    const rawMax = typeof args.maxResults === 'number' ? args.maxResults : 10;
    const maxResults = rawMax <= 0 || rawMax > 50 ? 10 : rawMax;

    try {
      const url = client.url('/_apis/projects', { 'api-version': '6.0' });
      const response = await client.get<TfsProjectsResponse>(
        url,
        'searching projects'
      );
      const allProjects: TfsProject[] = response.value ?? [];

      let projects: TfsProject[];
      if (!rawSearchTerm.trim()) {
        projects = allProjects.slice(0, maxResults);
      } else {
        const needle = rawSearchTerm.toLowerCase();
        projects = allProjects
          .filter((p) => {
            const nameMatch = (p.name ?? '').toLowerCase().includes(needle);
            const descMatch =
              !!p.description && p.description.toLowerCase().includes(needle);
            return nameMatch || descMatch;
          })
          .slice(0, maxResults);
      }

      if (projects.length === 0) {
        return rawSearchTerm.trim().length === 0
          ? "📁 **No project found**\n\n💡 **You may not have access to any projects or no project is configured**"
          : `🔍 **No project found for '${rawSearchTerm}'**\n\n💡 **Try other keywords or check the spelling**`;
      }

      const lines: string[] = [];
      const header = !rawSearchTerm.trim()
        ? `📁 **Microsoft TFS projects (first ${projects.length} results)**`
        : `🔍 **Projects found for '${rawSearchTerm}' (${projects.length} results)**`;
      lines.push(header);
      lines.push('');

      for (const project of projects) {
        lines.push('---');
        lines.push(`📋 **${project.name ?? ''}** \`${project.id ?? ''}\``);
        if (project.description) {
          lines.push(`📝 ${project.description}`);
        }
        lines.push(
          `📊 State: ${project.state ?? ''} | 👁️ Visibility: ${project.visibility ?? ''}`
        );
        const updatedShort = formatDateShort(project.lastUpdateTime);
        if (updatedShort) {
          lines.push(`🔄 Updated: ${updatedShort}`);
        }
        lines.push('');
      }

      if (projects.length === maxResults) {
        lines.push(
          `💡 *Display limited to ${maxResults} results. Use more specific keywords to refine the search.*`
        );
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('searching projects', err, {
        searchTerm: rawSearchTerm,
        maxResults,
      });
    }
  },
};

const getProject: ToolDefinition = {
  name: 'tfs_getproject',
  description: 'Fetches the details of a specific Microsoft TFS project',
  inputSchema: {
    type: 'object',
    properties: {
      projectName: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
    },
    required: ['projectName'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const projectName = typeof args.projectName === 'string' ? args.projectName : '';

    try {
      if (!projectName.trim()) {
        throw new Error('The project name is required');
      }

      const url = client.url(`/_apis/projects/${encodeURIComponent(projectName)}`, {
        'api-version': '6.0',
      });

      let project: TfsProject | null = null;
      try {
        project = await client.get<TfsProject>(url, 'fetching the project');
      } catch {
        project = null;
      }

      if (!project) {
        return `❌ **Project not found**\n\n🔍 **Searched name:** ${projectName}\n💡 **Check that the project name is correct and that you have access permissions**`;
      }

      const lines: string[] = [];
      lines.push(`📁 **Details of project ${project.name ?? ''}**`);
      lines.push('');
      lines.push('---');
      lines.push(`🔑 **ID:** ${project.id ?? ''}`);
      lines.push(`📋 **Name:** ${project.name ?? ''}`);
      if (project.description) {
        lines.push(`📝 **Description:** ${project.description}`);
      }
      lines.push(`📊 **State:** ${project.state ?? ''}`);
      lines.push(`👁️ **Visibility:** ${project.visibility ?? ''}`);
      const updated = formatDate(project.lastUpdateTime);
      if (updated) {
        lines.push(`🔄 **Last updated:** ${updated}`);
      }
      lines.push(`🔗 **URL:** ${project.url ?? ''}`);

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching the project', err, {
        'Project name': projectName,
      });
    }
  },
};

export const projectTools: ToolDefinition[] = [
  getProjects,
  searchProjects,
  getProject,
];
