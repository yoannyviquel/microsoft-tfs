import type { ToolDefinition } from './types.js';

interface ProjectsResponse {
  count?: number;
  value?: unknown[];
}

const testConnection: ToolDefinition = {
  name: 'tfs_testconnection',
  description: 'Tests the connection to Microsoft TFS and validates the credentials',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, { client }) => {
    try {
      const url = client.url('/_apis/projects', { 'api-version': '6.0', '$top': 1 });
      await client.get<ProjectsResponse>(url, 'testing the Microsoft TFS connection');
      return '✅ **Microsoft TFS connection successful!**\n\n🔗 **Status:** Authentication validated';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `❌ **Microsoft TFS connection failed:**\n\n⚠️ ${message}`;
    }
  },
};

export const connectionTools: ToolDefinition[] = [testConnection];
