import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AzureDevOpsClient } from "./client.ts";
import { registerProjectTools } from "./tools/projects.ts";
import { registerRepoTools } from "./tools/repos.ts";
import { registerWorkItemTools } from "./tools/workItems.ts";
import { VERSION } from "./version.ts";

export function createServer(client: AzureDevOpsClient, readOnly: boolean): McpServer {
  const server = new McpServer(
    { name: "azdo-mcp", version: VERSION },
    {
      instructions:
        `Tools for the Azure DevOps organization ${client.orgUrl}` +
        (client.defaultProject ? ` (default project: ${client.defaultProject})` : "") +
        ". Work items are bugs, tasks, user stories and similar; when the user gives a bare number, " +
        "treat it as a work item ID unless they say it is a pull request." +
        (readOnly ? " The server is read-only: it cannot create or change anything." : ""),
    },
  );
  const context = { client, readOnly };
  registerProjectTools(server, context);
  registerWorkItemTools(server, context);
  registerRepoTools(server, context);
  return server;
}
