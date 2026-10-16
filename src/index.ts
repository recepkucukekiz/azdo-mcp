#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { azureCliAuth, patAuth } from "./auth.ts";
import { AzureDevOpsClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { createServer } from "./server.ts";
import { VERSION } from "./version.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const auth = config.pat ? patAuth(config.pat) : azureCliAuth();
  const client = new AzureDevOpsClient(config.orgUrl, auth, config.defaultProject);
  const server = createServer(client, config.readOnly);

  await server.connect(new StdioServerTransport());
  console.error(
    `azdo-mcp ${VERSION} ready for ${config.orgUrl} (${config.pat ? "PAT" : "Azure CLI"} auth${config.readOnly ? ", read-only" : ""})`,
  );
}

main().catch((err: unknown) => {
  console.error(`azdo-mcp: ${errorMessage(err)}`);
  process.exit(1);
});
