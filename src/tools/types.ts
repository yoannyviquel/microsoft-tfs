import type { TfsClient } from '../tfs-client.js';

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  client: TfsClient;
}

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: (args: TArgs, ctx: ToolContext) => Promise<string>;
}
