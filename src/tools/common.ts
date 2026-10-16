import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AzureDevOpsClient } from "../client.ts";
import { errorMessage } from "../errors.ts";

export interface ToolContext {
  client: AzureDevOpsClient;
  /** When true, tools that change data are not registered. */
  readOnly: boolean;
}

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const OVERWRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export const projectParam = z
  .string()
  .optional()
  .describe("Project name or ID. Defaults to the AZURE_DEVOPS_PROJECT setting.");

/** Runs a tool body and turns its value, or the error it throws, into a tool result. */
export async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await body();
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
