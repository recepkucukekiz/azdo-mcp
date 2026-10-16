import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact } from "../format.ts";
import { READ, run, type ToolContext } from "./common.ts";

interface Project {
  id: string;
  name: string;
  description?: string;
  visibility?: string;
  lastUpdateTime?: string;
}

export function registerProjectTools(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Lists the projects in the Azure DevOps organization.",
      inputSchema: {
        top: z.number().int().min(1).max(500).default(100).describe("Maximum number of projects to return."),
      },
      annotations: READ,
    },
    ({ top }) =>
      run(async () => {
        const { value } = await client.get<{ value: Project[] }>("/_apis/projects", {
          query: { $top: top, stateFilter: "wellFormed" },
        });
        return {
          organization: client.orgUrl,
          defaultProject: client.defaultProject,
          projects: value.map((p) =>
            compact({ name: p.name, id: p.id, description: p.description, visibility: p.visibility }),
          ),
        };
      }),
  );
}
