import type { ToolDefinition } from './types.js';
import { connectionTools } from './connection.js';
import { projectTools } from './projects.js';
import { workItemTools } from './work-items.js';
import { repositoryTools } from './repositories.js';
import { buildTools } from './builds.js';
import { releaseTools } from './releases.js';
import { pullRequestTools } from './pull-requests.js';
import { branchTools } from './branches.js';

export const allTools: ToolDefinition[] = [
  ...connectionTools,
  ...projectTools,
  ...workItemTools,
  ...repositoryTools,
  ...buildTools,
  ...releaseTools,
  ...pullRequestTools,
  ...branchTools,
];
