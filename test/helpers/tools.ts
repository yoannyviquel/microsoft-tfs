import assert from 'node:assert/strict';
import { allTools } from '../../src/tools/index.js';
import type { ToolContext } from '../../src/tools/types.js';

/** Find a registered tool by name, failing the test if it is missing. */
export function getTool(name: string) {
  const tool = allTools.find((t) => t.name === name);
  assert.ok(tool, `tool "${name}" is not registered in allTools`);
  return tool;
}

/** Invoke a tool handler by name with the given args + context. */
export function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  return getTool(name).handler(args, ctx);
}

/** Assert the output is a success (does not start with the ❌ error marker). */
export function assertOk(out: string): void {
  if (out.startsWith('❌')) {
    throw new Error(`expected success but handler returned an error:\n${out}`);
  }
}

/** Assert the output is a failure (starts with the ❌ error marker). */
export function assertError(out: string): void {
  if (!out.startsWith('❌')) {
    throw new Error(`expected an error (❌) but handler returned:\n${out}`);
  }
}
