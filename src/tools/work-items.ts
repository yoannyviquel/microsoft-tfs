import type { ToolDefinition } from './types.js';
import type {
  TfsWorkItem,
  TfsWorkItemPatchOperation,
  TfsQueryResult,
  TfsWorkItemBatchResponse,
} from '../models/tfs.js';
import { formatErrorResponse, formatWorkItemDetails } from '../formatting/markdown.js';

function requireString(value: unknown, displayName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}

function requireInteger(value: unknown, displayName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}

function projectPath(project: string, suffix: string): string {
  return `/${encodeURIComponent(project)}${suffix}`;
}

async function fetchWorkItemsBatch(
  client: import('../tfs-client.js').TfsClient,
  project: string,
  ids: number[]
): Promise<TfsWorkItem[]> {
  if (ids.length === 0) return [];
  const idsParam = ids.join(',');
  const url = client.url(projectPath(project, '/_apis/wit/workitems'), {
    ids: idsParam,
    'api-version': '6.0',
  });
  const response = await client.get<TfsWorkItemBatchResponse>(
    url,
    'fetching work items'
  );
  return response.value ?? [];
}

const createWorkItem: ToolDefinition = {
  name: 'tfs_createworkitem',
  description: 'Creates a new Microsoft TFS work item',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
      workItemType: {
        type: 'string',
        description: 'The work item type (Bug, Task, User Story, Feature, etc.)',
      },
      title: {
        type: 'string',
        description: 'The work item title',
      },
      description: {
        type: 'string',
        description: 'The detailed work item description (optional)',
      },
      assignedTo: {
        type: 'string',
        description: 'The assigned user (optional)',
      },
      priority: {
        type: 'integer',
        description:
          'The priority (1=Very high, 2=High, 3=Medium, 4=Low) - default 2',
      },
    },
    required: ['project', 'workItemType', 'title'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const workItemType = typeof args.workItemType === 'string' ? args.workItemType : '';
    const title = typeof args.title === 'string' ? args.title : '';
    const description = typeof args.description === 'string' ? args.description : undefined;
    const assignedTo = typeof args.assignedTo === 'string' ? args.assignedTo : undefined;
    const priority = typeof args.priority === 'number' ? args.priority : 2;

    try {
      requireString(project, 'The project name');
      requireString(workItemType, 'The work item type');
      requireString(title, 'The title');

      const patchDocument: TfsWorkItemPatchOperation[] = [];
      patchDocument.push({ op: 'add', path: '/fields/System.Title', value: title });
      if (description) {
        patchDocument.push({ op: 'add', path: '/fields/System.Description', value: description });
      }
      if (assignedTo) {
        patchDocument.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignedTo });
      }
      patchDocument.push({ op: 'add', path: '/fields/System.Priority', value: priority });

      const url = client.url(
        projectPath(project, `/_apis/wit/workitems/$${encodeURIComponent(workItemType)}`),
        { 'api-version': '6.0' }
      );

      const workItem = await client.request<TfsWorkItem>(
        'POST',
        url,
        patchDocument,
        {
          contentType: 'application/json-patch+json',
          operationName: 'creating the work item',
        }
      );

      const lines: string[] = [];
      lines.push('✅ **Microsoft TFS work item created successfully!**');
      lines.push('');
      lines.push(`🆔 **ID:** ${workItem.id ?? ''}`);
      lines.push(`📁 **Project:** ${project}`);
      lines.push(`📋 **Title:** ${title}`);
      lines.push(`🏷️ **Type:** ${workItemType}`);
      lines.push(`⚡ **Priority:** ${priority}`);
      if (description) {
        lines.push(`📝 **Description:** ${description}`);
      }
      if (assignedTo) {
        lines.push(`👤 **Assigned to:** ${assignedTo}`);
      }
      lines.push(`🔗 **Link:** ${workItem.url ?? ''}`);
      return lines.join('\n');
    } catch (err) {
      return formatErrorResponse('creating the Microsoft TFS work item', err, {
        Project: project,
        Type: workItemType,
        Title: title,
        Description: description ?? 'None',
        'Assigned to': assignedTo ?? 'None',
        Priority: priority,
      });
    }
  },
};

const addComment: ToolDefinition = {
  name: 'tfs_addcomment',
  description: 'Adds a comment to a Microsoft TFS work item',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
      workItemId: {
        type: 'integer',
        description: 'The work item ID',
      },
      comment: {
        type: 'string',
        description: 'The comment to add',
      },
    },
    required: ['project', 'workItemId', 'comment'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const workItemId = typeof args.workItemId === 'number' ? args.workItemId : NaN;
    const comment = typeof args.comment === 'string' ? args.comment : '';

    try {
      requireString(project, 'The project name');
      requireInteger(workItemId, 'The work item ID');
      requireString(comment, 'The comment');

      const url = client.url(
        projectPath(project, `/_apis/wit/workItems/${workItemId}/comments`),
        { 'api-version': '6.0' }
      );

      try {
        await client.request<unknown>(
          'POST',
          url,
          { text: comment },
          { operationName: 'adding the comment' }
        );
      } catch (innerErr) {
        const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
        return `❌ **Error while adding the comment:**\n\n⚠️ ${message}`;
      }

      const workItemUrl = `${client.baseUrl}/${client.organization}/${encodeURIComponent(project)}/_workitems/edit/${workItemId}`;
      return (
        `✅ **Comment added successfully!**\n\n` +
        `🔑 **Work Item:** ${workItemId}\n` +
        `💬 **Comment:** ${comment}\n\n` +
        `🔗 **Link:** ${workItemUrl}`
      );
    } catch (err) {
      return formatErrorResponse('adding the comment', err, {
        Project: project,
        'Work Item ID': Number.isFinite(workItemId) ? workItemId : '',
        Comment: comment,
      });
    }
  },
};

const searchWorkItems: ToolDefinition = {
  name: 'tfs_searchworkitems',
  description: 'Searches Microsoft TFS work items by ID or title keywords',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
      searchTerm: {
        type: 'string',
        description: 'Search term - work item ID or title keywords',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of results to return (default 10)',
      },
    },
    required: ['project', 'searchTerm'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const searchTerm = typeof args.searchTerm === 'string' ? args.searchTerm : '';
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 10;

    try {
      requireString(project, 'The project name');
      requireString(searchTerm, 'The search term');

      const numericId = /^-?\d+$/.test(searchTerm.trim())
        ? Number.parseInt(searchTerm.trim(), 10)
        : null;

      const wiql =
        numericId !== null
          ? `SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.Id] = ${numericId}`
          : `SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.Title] CONTAINS '${searchTerm}'`;

      const wiqlUrl = client.url(projectPath(project, '/_apis/wit/wiql'), {
        'api-version': '6.0',
      });

      const queryResult = await client.request<TfsQueryResult>(
        'POST',
        wiqlUrl,
        { query: wiql },
        { operationName: 'searching' }
      );

      const refs = queryResult.workItems ?? [];
      const workItems =
        refs.length > 0
          ? await fetchWorkItemsBatch(
              client,
              project,
              refs.slice(0, maxResults).map((wi) => wi.id)
            )
          : [];

      if (workItems.length === 0) {
        return (
          `🔍 **No work item found for '${searchTerm}' in project '${project}'**\n\n` +
          `💡 **Suggestions:**\n` +
          `- Check the spelling of the search term\n` +
          `- Use more general keywords\n` +
          `- Search by work item ID`
        );
      }

      const lines: string[] = [];
      lines.push(`🔍 **Search results for '${searchTerm}' in '${project}'**`);
      lines.push('');
      lines.push(`📊 **${workItems.length} work item(s) found**`);
      lines.push('');

      for (const workItem of workItems) {
        lines.push('---');
        lines.push(formatWorkItemDetails(workItem).trimEnd());
        lines.push('');
      }

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('searching', err, {
        Project: project,
        'Search term': searchTerm,
        'Maximum number of results': maxResults,
      });
    }
  },
};

const getWorkItem: ToolDefinition = {
  name: 'tfs_getworkitem',
  description: 'Fetches the complete details of a Microsoft TFS work item',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
      workItemId: {
        type: 'integer',
        description: 'The work item ID',
      },
    },
    required: ['project', 'workItemId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const workItemId = typeof args.workItemId === 'number' ? args.workItemId : NaN;

    try {
      requireString(project, 'The project name');
      requireInteger(workItemId, 'The work item ID');

      const url = client.url(
        projectPath(project, `/_apis/wit/workitems/${workItemId}`),
        { 'api-version': '6.0' }
      );

      let workItem: TfsWorkItem | null = null;
      try {
        workItem = await client.get<TfsWorkItem>(
          url,
          'fetching the work item'
        );
      } catch {
        workItem = null;
      }

      if (!workItem || workItem.id === undefined) {
        return (
          `❌ **Work item not found**\n\n` +
          `🔍 **Searched ID:** ${workItemId} in project '${project}'\n` +
          `💡 **Check that the work item ID is correct and that you have access permissions**`
        );
      }

      const lines: string[] = [];
      lines.push(`📋 **Details of work item ${workItem.id}**`);
      lines.push('');
      lines.push('---');
      lines.push(formatWorkItemDetails(workItem, true).trimEnd());

      return lines.join('\n') + '\n';
    } catch (err) {
      return formatErrorResponse('fetching the work item', err, {
        Project: project,
        'Work Item ID': Number.isFinite(workItemId) ? workItemId : '',
      });
    }
  },
};

const updateWorkItem: ToolDefinition = {
  name: 'tfs_updateworkitem',
  description: 'Updates an existing Microsoft TFS work item',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
      workItemId: {
        type: 'integer',
        description: 'The ID of the work item to update',
      },
      title: {
        type: 'string',
        description: 'The new title (optional)',
      },
      description: {
        type: 'string',
        description: 'The new description (optional)',
      },
      assignedTo: {
        type: 'string',
        description: 'The new assignee (optional)',
      },
      state: {
        type: 'string',
        description: 'The new state (optional)',
      },
      priority: {
        type: 'integer',
        description: 'The new priority (1-4) (optional)',
      },
    },
    required: ['project', 'workItemId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const workItemId = typeof args.workItemId === 'number' ? args.workItemId : NaN;
    const title = typeof args.title === 'string' ? args.title : undefined;
    const description = typeof args.description === 'string' ? args.description : undefined;
    const assignedTo = typeof args.assignedTo === 'string' ? args.assignedTo : undefined;
    const state = typeof args.state === 'string' ? args.state : undefined;
    const priority = typeof args.priority === 'number' ? args.priority : undefined;

    try {
      requireString(project, 'The project name');
      requireInteger(workItemId, 'The work item ID');

      const hasTitle = !!title && title.trim().length > 0;
      const hasDescription = !!description && description.trim().length > 0;
      const hasAssignedTo = !!assignedTo && assignedTo.trim().length > 0;
      const hasState = !!state && state.trim().length > 0;
      const hasPriority = priority !== undefined && priority !== null;

      if (!hasTitle && !hasDescription && !hasAssignedTo && !hasState && !hasPriority) {
        throw new Error('At least one field to update must be provided');
      }

      const patchDocument: TfsWorkItemPatchOperation[] = [];
      if (hasTitle) {
        patchDocument.push({ op: 'replace', path: '/fields/System.Title', value: title });
      }
      if (hasDescription) {
        patchDocument.push({
          op: 'replace',
          path: '/fields/System.Description',
          value: description,
        });
      }
      if (hasAssignedTo) {
        patchDocument.push({
          op: 'replace',
          path: '/fields/System.AssignedTo',
          value: assignedTo,
        });
      }
      if (hasState) {
        patchDocument.push({ op: 'replace', path: '/fields/System.State', value: state });
      }
      if (hasPriority) {
        patchDocument.push({
          op: 'replace',
          path: '/fields/System.Priority',
          value: priority,
        });
      }

      const url = client.url(
        projectPath(project, `/_apis/wit/workitems/${workItemId}`),
        { 'api-version': '6.0' }
      );

      await client.request<TfsWorkItem>('PATCH', url, patchDocument, {
        contentType: 'application/json-patch+json',
        operationName: 'updating the work item',
      });

      const updateDetails: string[] = [];
      if (hasTitle) updateDetails.push(`📋 **Title:** ${title}`);
      if (hasDescription) updateDetails.push(`📝 **Description:** ${description}`);
      if (hasAssignedTo) updateDetails.push(`👤 **Assigned to:** ${assignedTo}`);
      if (hasState) updateDetails.push(`📊 **State:** ${state}`);
      if (hasPriority) updateDetails.push(`⚡ **Priority:** ${priority}`);

      return (
        `✅ **Microsoft TFS work item updated successfully!**\n\n` +
        `🔑 **ID:** ${workItemId}\n` +
        `📁 **Project:** ${project}\n\n` +
        `**Updated fields:**\n` +
        updateDetails.join('\n')
      );
    } catch (err) {
      return formatErrorResponse('updating the Microsoft TFS work item', err, {
        Project: project,
        'Work Item ID': Number.isFinite(workItemId) ? workItemId : '',
        Title: title ?? 'Unchanged',
        Description: description ?? 'Unchanged',
        'Assigned to': assignedTo ?? 'Unchanged',
        State: state ?? 'Unchanged',
        Priority: priority !== undefined ? priority : 'Unchanged',
      });
    }
  },
};

const deleteWorkItem: ToolDefinition = {
  name: 'tfs_deleteworkitem',
  description: 'Deletes a Microsoft TFS work item',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'The Microsoft TFS project name',
      },
      workItemId: {
        type: 'integer',
        description: 'The ID of the work item to delete',
      },
    },
    required: ['project', 'workItemId'],
    additionalProperties: false,
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === 'string' ? args.project : '';
    const workItemId = typeof args.workItemId === 'number' ? args.workItemId : NaN;

    try {
      requireString(project, 'The project name');
      requireInteger(workItemId, 'The work item ID');

      const url = client.url(
        projectPath(project, `/_apis/wit/workitems/${workItemId}`),
        { 'api-version': '6.0' }
      );

      await client.request<unknown>('DELETE', url, undefined, {
        operationName: 'deleting the work item',
      });

      return (
        `✅ **Microsoft TFS work item deleted successfully!**\n\n` +
        `🔑 **Deleted ID:** ${workItemId}\n` +
        `📁 **Project:** ${project}\n\n` +
        `⚠️ **Warning:** This action is irreversible. The work item and all its associated data have been permanently deleted.`
      );
    } catch (err) {
      return formatErrorResponse('deleting the Microsoft TFS work item', err, {
        Project: project,
        'Work Item ID': Number.isFinite(workItemId) ? workItemId : '',
      });
    }
  },
};

export const workItemTools: ToolDefinition[] = [
  createWorkItem,
  addComment,
  searchWorkItems,
  getWorkItem,
  updateWorkItem,
  deleteWorkItem,
];
