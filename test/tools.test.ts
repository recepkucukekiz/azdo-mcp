// Runs the tools through a real MCP client against a fake Azure DevOps REST API.
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { patAuth } from "../src/auth.ts";
import { AzureDevOpsClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: any;
}

interface Reply {
  status?: number;
  body?: unknown;
  contentType?: string;
}

const requests: Recorded[] = [];
let routes: Record<string, Reply | ((req: Recorded) => Reply)> = {};
let base = "";

const workItem42 = {
  id: 42,
  rev: 3,
  fields: {
    "System.WorkItemType": "Bug",
    "System.Title": "Login fails",
    "System.State": "Active",
    "System.AssignedTo": { displayName: "Jane Doe", uniqueName: "jane@contoso.com" },
    "System.TeamProject": "Web App",
    "System.Tags": "ui; safari",
    "System.Description": "<div>Breaks on <b>Safari</b></div>",
    "Custom.Customer": "Fabrikam",
  },
  relations: [
    { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://x/_apis/wit/workItems/40", attributes: {} },
    { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/p%2Fr%2F7", attributes: { name: "Pull Request" } },
  ],
};

const pullRequest7 = {
  pullRequestId: 7,
  title: "Fix Safari login",
  status: "active",
  sourceRefName: "refs/heads/feature/x",
  targetRefName: "refs/heads/main",
  createdBy: { displayName: "Bob" },
  reviewers: [{ displayName: "Jane Doe", uniqueName: "jane@contoso.com", vote: 10, isRequired: true }],
  repository: { id: "r1", name: "web", project: { id: "p1", name: "Web App" } },
  lastMergeSourceCommit: { commitId: "abc" },
};

function defaultRoutes(): typeof routes {
  return {
    "GET /_apis/wit/workitems/42": { body: workItem42 },
    "GET /Web%20App/_apis/wit/workItems/42/comments": {
      body: { totalCount: 1, comments: [{ id: 1, text: "<p>Repro&#39;d</p>", createdBy: { displayName: "Bob" } }] },
    },
    "POST /_apis/wit/workitemsbatch": (req) => ({
      body: { value: req.body.ids.map((id: number) => (id === 42 ? workItem42 : null)) },
    }),
    "GET /_apis/git/pullrequests/7": { body: pullRequest7 },
    "GET /Web%20App/_apis/git/repositories/r1/pullRequests/7/workitems": { body: { value: [{ id: "42" }] } },
  };
}

const http = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const recorded: Recorded = {
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    body: raw ? JSON.parse(raw) : undefined,
  };
  requests.push(recorded);
  const route = routes[`${recorded.method} ${recorded.path}`];
  const reply = (typeof route === "function" ? route(recorded) : route) ?? {
    status: 404,
    body: { message: `No route for ${recorded.method} ${recorded.path}` },
  };
  res.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "application/json" });
  res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
});

before(async () => {
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

after(() => {
  http.closeAllConnections();
  http.close();
});

beforeEach(() => {
  requests.length = 0;
  routes = defaultRoutes();
});

async function connect(readOnly = false): Promise<Client> {
  const server = createServer(new AzureDevOpsClient(base, patAuth("secret"), "Web App"), readOnly);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function call(name: string, args: Record<string, unknown>) {
  const client = await connect();
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    return { isError: Boolean(result.isError), text, json: () => JSON.parse(text) };
  } finally {
    await client.close();
  }
}

function lastRequest(method: string, path: string): Recorded {
  const found = requests.findLast((r) => r.method === method && r.path === path);
  assert.ok(found, `expected ${method} ${path}; got ${requests.map((r) => `${r.method} ${r.path}`).join(", ")}`);
  return found;
}

test("read-only mode leaves out the tools that change data", async () => {
  const full = await connect(false);
  const readOnly = await connect(true);
  const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
  const all = await names(full);
  const reads = await names(readOnly);
  assert.ok(all.includes("create_work_item") && all.includes("add_pull_request_comment"));
  assert.deepEqual(
    all.filter((n) => !reads.includes(n)).sort(),
    ["add_pull_request_comment", "add_work_item_comment", "create_pull_request", "create_work_item", "link_work_items", "update_work_item"],
  );
  await full.close();
  await readOnly.close();
});

test("get_work_item returns readable details, links and comments", async () => {
  const result = await call("get_work_item", { id: 42, includeAllFields: true });
  assert.equal(result.isError, false, result.text);
  const item = result.json();
  assert.equal(item.title, "Login fails");
  assert.equal(item.assignedTo, "Jane Doe <jane@contoso.com>");
  assert.equal(item.description, "Breaks on Safari");
  assert.deepEqual(item.tags, ["ui", "safari"]);
  assert.deepEqual(item.relations, [
    { type: "parent", workItemId: 40 },
    { type: "Pull Request", pullRequestId: 7 },
  ]);
  assert.deepEqual(item.comments, [{ author: "Bob", text: "Repro'd" }]);
  assert.deepEqual(item.otherFields, { "Custom.Customer": "Fabrikam" });
  assert.equal(item.url, `${base}/Web%20App/_workitems/edit/42`);

  const request = lastRequest("GET", "/_apis/wit/workitems/42");
  assert.equal(request.headers.authorization, `Basic ${Buffer.from(":secret").toString("base64")}`);
  assert.equal(request.query.get("$expand"), "relations");
  assert.equal(request.query.get("api-version"), "7.1");
});

test("find_work_items builds WIQL from filters", async () => {
  routes["POST /Web%20App/_apis/wit/wiql"] = { body: { workItems: [{ id: 42 }, { id: 43 }] } };
  const result = await call("find_work_items", { assignedTo: "@me", type: "Bug", text: "O'Brien", top: 10 });
  assert.equal(result.isError, false, result.text);
  const found = result.json();
  assert.equal(found.count, 1);
  assert.equal(found.workItems[0].id, 42);
  const wiql = lastRequest("POST", "/Web%20App/_apis/wit/wiql").body.query as string;
  assert.match(wiql, /\[System\.AssignedTo\] = @Me/);
  assert.match(wiql, /\[System\.WorkItemType\] = 'Bug'/);
  assert.match(wiql, /\[System\.Title\] CONTAINS 'O''Brien'/);
  assert.match(wiql, /\[System\.State\] NOT IN \('Closed'/);
  assert.deepEqual(lastRequest("POST", "/_apis/wit/workitemsbatch").body.ids, [42, 43]);
});

test("create_work_item sends a JSON Patch with fields and parent link", async () => {
  routes["POST /Web%20App/_apis/wit/workitems/$User%20Story"] = { body: { ...workItem42, id: 50 } };
  const result = await call("create_work_item", {
    type: "User Story",
    title: "Remember me",
    description: "Line 1\nLine <2>",
    tags: ["auth", "login"],
    parentId: 40,
  });
  assert.equal(result.isError, false, result.text);
  const request = lastRequest("POST", "/Web%20App/_apis/wit/workitems/$User%20Story");
  assert.equal(request.headers["content-type"], "application/json-patch+json");
  assert.deepEqual(request.body, [
    { op: "add", path: "/fields/System.Title", value: "Remember me" },
    { op: "add", path: "/fields/System.Description", value: "Line 1<br>Line &lt;2&gt;" },
    { op: "add", path: "/fields/System.Tags", value: "auth; login" },
    {
      op: "add",
      path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${base}/_apis/wit/workItems/40` },
    },
  ]);
});

test("update_work_item refuses an empty update", async () => {
  const result = await call("update_work_item", { id: 42 });
  assert.equal(result.isError, true);
  assert.match(result.text, /Nothing to update/);
});

test("get_pull_request shows reviewers and linked work items", async () => {
  const result = await call("get_pull_request", { id: 7 });
  assert.equal(result.isError, false, result.text);
  const pr = result.json();
  assert.equal(pr.source, "feature/x");
  assert.equal(pr.target, "main");
  assert.deepEqual(pr.reviewers, ["Jane Doe <jane@contoso.com>: approved (required)"]);
  assert.equal(pr.workItems[0].title, "Login fails");
  assert.equal(pr.url, `${base}/Web%20App/_git/web/pullrequest/7`);
});

test("add_pull_request_comment starts a thread on a file line", async () => {
  routes["POST /Web%20App/_apis/git/repositories/r1/pullRequests/7/threads"] = { body: { id: 9, comments: [] } };
  const result = await call("add_pull_request_comment", { id: 7, content: "Nit", filePath: "src/a.ts", line: 5 });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(lastRequest("POST", "/Web%20App/_apis/git/repositories/r1/pullRequests/7/threads").body, {
    comments: [{ parentCommentId: 0, content: "Nit", commentType: 1 }],
    status: 1,
    threadContext: {
      filePath: "/src/a.ts",
      rightFileStart: { line: 5, offset: 1 },
      rightFileEnd: { line: 5, offset: 1 },
    },
  });
});

test("a sign-in page is reported as an authentication problem", async () => {
  routes["GET /_apis/projects"] = { status: 203, body: "<html>Sign in</html>", contentType: "text/html" };
  const result = await call("list_projects", {});
  assert.equal(result.isError, true);
  assert.match(result.text, /sign-in page/);
});

test("API errors carry the Azure DevOps message", async () => {
  const result = await call("get_work_item", { id: 999 });
  assert.equal(result.isError, true);
  assert.match(result.text, /Azure DevOps API error 404: No route for GET \/_apis\/wit\/workitems\/999 Check the organization/);
});
