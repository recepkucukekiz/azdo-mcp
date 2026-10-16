import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AzureDevOpsClient, seg } from "../client.ts";
import { AzureDevOpsError } from "../errors.ts";
import { compact, htmlToText, identityName, textToHtml, truncate, wiqlString } from "../format.ts";
import { chunk, OVERWRITE, projectParam, READ, run, type ToolContext, WRITE } from "./common.ts";

interface WorkItem {
  id: number;
  rev?: number;
  fields: Record<string, unknown>;
  relations?: Relation[];
}

interface Relation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
}

interface Comment {
  id: number;
  text: string;
  createdBy?: unknown;
  createdDate?: string;
}

interface PatchOperation {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

/** Link types by the name of what the target is to the source ("parent": the target is the source's parent). */
export const LINK_TYPES = {
  parent: "System.LinkTypes.Hierarchy-Reverse",
  child: "System.LinkTypes.Hierarchy-Forward",
  related: "System.LinkTypes.Related",
  predecessor: "System.LinkTypes.Dependency-Reverse",
  successor: "System.LinkTypes.Dependency-Forward",
  duplicate: "System.LinkTypes.Duplicate-Forward",
  "duplicate-of": "System.LinkTypes.Duplicate-Reverse",
} as const;

const RELATION_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(LINK_TYPES).map(([name, rel]) => [rel, name]),
);

/** Fields fetched for work item lists. */
const SUMMARY_FIELDS = [
  "System.Id",
  "System.WorkItemType",
  "System.Title",
  "System.State",
  "System.AssignedTo",
  "System.TeamProject",
  "System.AreaPath",
  "System.IterationPath",
  "System.Tags",
  "System.ChangedDate",
  "Microsoft.VSTS.Common.Priority",
];

/** States that mean a work item is finished in the built-in processes. */
const CLOSED_STATES = ["Closed", "Done", "Removed", "Completed", "Cut"];

/** Fields that get_work_item already shows under their own names. */
const SHOWN_FIELDS = new Set([
  ...SUMMARY_FIELDS,
  "System.Reason",
  "System.CreatedBy",
  "System.CreatedDate",
  "System.ChangedBy",
  "System.Parent",
  "System.Description",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.TCM.ReproSteps",
  "Microsoft.VSTS.Scheduling.StoryPoints",
  "Microsoft.VSTS.Scheduling.Effort",
  "Microsoft.VSTS.Scheduling.OriginalEstimate",
  "Microsoft.VSTS.Scheduling.RemainingWork",
  "Microsoft.VSTS.Scheduling.CompletedWork",
  "Microsoft.VSTS.Common.Severity",
]);

const TEXT_LIMIT = 20_000;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function splitTags(value: unknown): string[] {
  return str(value)?.split(";").map((t) => t.trim()).filter(Boolean) ?? [];
}

export function workItemWebUrl(orgUrl: string, project: string | undefined, id: number): string {
  return project ? `${orgUrl}/${seg(project)}/_workitems/edit/${id}` : `${orgUrl}/_workitems/edit/${id}`;
}

export function describeRelation(relation: Relation): Record<string, unknown> {
  const comment = str(relation.attributes?.comment);
  const workItem = /\/workItems\/(\d+)$/i.exec(relation.url);
  if (workItem) {
    return compact({
      type: RELATION_NAMES[relation.rel] ?? str(relation.attributes?.name) ?? relation.rel,
      workItemId: Number(workItem[1]),
      comment,
    });
  }
  const name = str(relation.attributes?.name) ?? relation.rel;
  if (name === "Pull Request") {
    // vstfs:///Git/PullRequestId/{projectId}%2F{repositoryId}%2F{pullRequestId}
    const id = Number(decodeURIComponent(relation.url).split("/").pop());
    if (Number.isInteger(id)) return compact({ type: name, pullRequestId: id, comment });
  }
  return compact({ type: name, url: relation.url, comment });
}

export function summarizeWorkItem(item: WorkItem, orgUrl: string): Record<string, unknown> {
  const f = item.fields;
  const project = str(f["System.TeamProject"]);
  return compact({
    id: item.id,
    type: f["System.WorkItemType"],
    title: f["System.Title"],
    state: f["System.State"],
    assignedTo: identityName(f["System.AssignedTo"]),
    priority: f["Microsoft.VSTS.Common.Priority"],
    project,
    areaPath: f["System.AreaPath"],
    iterationPath: f["System.IterationPath"],
    tags: splitTags(f["System.Tags"]),
    changedDate: f["System.ChangedDate"],
    url: workItemWebUrl(orgUrl, project, item.id),
  });
}

function detailWorkItem(item: WorkItem, orgUrl: string, allFields: boolean): Record<string, unknown> {
  const f = item.fields;
  const text = (name: string) => truncate(htmlToText(f[name]), TEXT_LIMIT);
  const details: Record<string, unknown> = compact({
    ...summarizeWorkItem(item, orgUrl),
    reason: f["System.Reason"],
    parentId: f["System.Parent"],
    createdBy: identityName(f["System.CreatedBy"]),
    createdDate: f["System.CreatedDate"],
    changedBy: identityName(f["System.ChangedBy"]),
    severity: f["Microsoft.VSTS.Common.Severity"],
    storyPoints: f["Microsoft.VSTS.Scheduling.StoryPoints"],
    effort: f["Microsoft.VSTS.Scheduling.Effort"],
    originalEstimate: f["Microsoft.VSTS.Scheduling.OriginalEstimate"],
    remainingWork: f["Microsoft.VSTS.Scheduling.RemainingWork"],
    completedWork: f["Microsoft.VSTS.Scheduling.CompletedWork"],
    description: text("System.Description"),
    acceptanceCriteria: text("Microsoft.VSTS.Common.AcceptanceCriteria"),
    reproSteps: text("Microsoft.VSTS.TCM.ReproSteps"),
    relations: (item.relations ?? []).map(describeRelation),
  });
  if (allFields) {
    const other: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(f)) {
      if (SHOWN_FIELDS.has(name)) continue;
      other[name] =
        typeof value === "string" && /<\/?[a-z][^>]*>/i.test(value)
          ? htmlToText(value)
          : (identityName(value) ?? value);
    }
    details.otherFields = other;
  }
  return details;
}

/** Fetches list summaries for the given IDs, keeping their order. */
export async function fetchSummaries(client: AzureDevOpsClient, ids: number[]): Promise<Record<string, unknown>[]> {
  const found = new Map<number, WorkItem>();
  for (const batch of chunk([...new Set(ids)], 200)) {
    const { value } = await client.post<{ value: (WorkItem | null)[] }>("/_apis/wit/workitemsbatch", {
      ids: batch,
      fields: SUMMARY_FIELDS,
      errorPolicy: "omit",
    });
    for (const item of value) if (item) found.set(item.id, item);
  }
  return ids.flatMap((id) => {
    const item = found.get(id);
    return item ? [summarizeWorkItem(item, client.orgUrl)] : [];
  });
}

interface WiqlResult {
  workItems?: { id: number }[];
  workItemRelations?: { source?: { id: number } | null; target?: { id: number } | null }[];
}

async function runWiql(
  client: AzureDevOpsClient,
  query: string,
  top: number,
  project: string | undefined,
  team: string | undefined,
): Promise<{ count: number; workItems: Record<string, unknown>[]; note?: string }> {
  if (team && !project) throw new AzureDevOpsError("`team` needs a project as well.");
  const scope = project ? `/${seg(project)}${team ? `/${seg(team)}` : ""}` : "";
  const result = await client.post<WiqlResult>(`${scope}/_apis/wit/wiql`, { query }, { query: { $top: top } });
  const ids = result.workItems
    ? result.workItems.map((w) => w.id)
    : (result.workItemRelations ?? []).flatMap((r) => [r.source?.id, r.target?.id]).filter((id) => id !== undefined);
  const unique = [...new Set(ids)].slice(0, top);
  const workItems = await fetchSummaries(client, unique);
  return compact({
    count: workItems.length,
    workItems,
    note: unique.length === top ? `Stopped at ${top} results; raise \`top\` or narrow the query for more.` : undefined,
  }) as { count: number; workItems: Record<string, unknown>[]; note?: string };
}

const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const editableShape = {
  title: z.string().min(1).optional(),
  description: z.string().optional().describe("Description. Plain text unless `html` is true."),
  acceptanceCriteria: z.string().optional().describe("Acceptance criteria. Plain text unless `html` is true."),
  assignedTo: z.string().optional().describe("Display name or email of the assignee; an empty string unassigns."),
  state: z.string().optional().describe("State name, e.g. Active, Resolved, Closed. See list_work_item_types."),
  areaPath: z.string().optional(),
  iterationPath: z.string().optional().describe("Iteration (sprint) path, e.g. MyProject\\Sprint 12."),
  tags: z.array(z.string()).optional().describe("Tags. Replaces the existing tags."),
  priority: z.number().int().min(1).max(4).optional(),
  fields: z
    .record(z.string(), fieldValue)
    .optional()
    .describe('Any other fields by reference name, e.g. {"Microsoft.VSTS.Scheduling.StoryPoints": 3}.'),
  html: z.boolean().default(false).describe("Send description and acceptanceCriteria as HTML instead of plain text."),
};
const editableSchema = z.object(editableShape);
type EditableFields = z.infer<typeof editableSchema>;

function fieldOperations(input: EditableFields): PatchOperation[] {
  const rich = (text: string | undefined) => (text === undefined || input.html ? text : textToHtml(text));
  const values: Record<string, unknown> = {
    "System.Title": input.title,
    "System.Description": rich(input.description),
    "Microsoft.VSTS.Common.AcceptanceCriteria": rich(input.acceptanceCriteria),
    "System.AssignedTo": input.assignedTo,
    "System.State": input.state,
    "System.AreaPath": input.areaPath,
    "System.IterationPath": input.iterationPath,
    "System.Tags": input.tags?.join("; "),
    "Microsoft.VSTS.Common.Priority": input.priority,
    ...input.fields,
  };
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ({ op: "add", path: `/fields/${name}`, value }));
}

function linkOperation(client: AzureDevOpsClient, rel: string, targetId: number, comment?: string): PatchOperation {
  return {
    op: "add",
    path: "/relations/-",
    value: compact({
      rel,
      url: `${client.orgUrl}/_apis/wit/workItems/${targetId}`,
      attributes: comment ? { comment } : undefined,
    }),
  };
}

export function registerWorkItemTools(server: McpServer, { client, readOnly }: ToolContext): void {
  server.registerTool(
    "get_work_item",
    {
      title: "Get work item",
      description:
        "Gets one work item (bug, task, user story, ...) by ID with its description, acceptance criteria, " +
        "links (parent, children, pull requests) and optionally its discussion comments.",
      inputSchema: {
        id: z.number().int().positive().describe("Work item ID."),
        includeComments: z.boolean().default(true).describe("Include the latest discussion comments."),
        commentLimit: z.number().int().min(1).max(200).default(20),
        includeAllFields: z.boolean().default(false).describe("Also return every other field, including custom ones."),
      },
      annotations: READ,
    },
    ({ id, includeComments, commentLimit, includeAllFields }) =>
      run(async () => {
        const item = await client.get<WorkItem>(`/_apis/wit/workitems/${id}`, { query: { $expand: "relations" } });
        const details = detailWorkItem(item, client.orgUrl, includeAllFields);
        const project = str(item.fields["System.TeamProject"]);
        if (includeComments && project) {
          const { comments, totalCount } = await client.get<{ comments: Comment[]; totalCount: number }>(
            `/${seg(project)}/_apis/wit/workItems/${id}/comments`,
            { query: { $top: commentLimit, order: "desc" }, apiVersion: "7.1-preview.4" },
          );
          details.commentCount = totalCount;
          details.comments = comments.reverse().map((c) =>
            compact({
              author: identityName(c.createdBy),
              date: c.createdDate,
              text: truncate(htmlToText(c.text), 4000),
            }),
          );
        }
        return details;
      }),
  );

  server.registerTool(
    "get_work_items",
    {
      title: "Get several work items",
      description: "Gets a short summary (title, state, assignee, ...) of several work items at once.",
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(1000).describe("Work item IDs."),
      },
      annotations: READ,
    },
    ({ ids }) => run(() => fetchSummaries(client, ids)),
  );

  server.registerTool(
    "query_work_items",
    {
      title: "Query work items with WIQL",
      description:
        "Runs a WIQL (Work Item Query Language) query and returns the matching work items. Example: " +
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me " +
        "AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC",
      inputSchema: {
        wiql: z.string().min(1).describe("The WIQL query. Only the IDs it selects are used."),
        project: projectParam.describe("Project the query runs in (needed for @project). Defaults to AZURE_DEVOPS_PROJECT."),
        team: z.string().optional().describe("Team, for queries that use @CurrentIteration."),
        top: z.number().int().min(1).max(1000).default(50).describe("Maximum number of work items to return."),
      },
      annotations: READ,
    },
    ({ wiql, project, team, top }) => run(() => runWiql(client, wiql, top, client.optionalProject(project), team)),
  );

  server.registerTool(
    "find_work_items",
    {
      title: "Find work items",
      description:
        "Finds work items by simple filters (assignee, type, state, text in title, tags, area, iteration) " +
        "without writing WIQL. Use assignedTo \"@Me\" for the signed-in user's work items.",
      inputSchema: {
        project: projectParam,
        assignedTo: z.string().optional().describe('"@Me", a display name or an email.'),
        type: z.string().optional().describe("Work item type, e.g. Bug, Task, User Story, Product Backlog Item."),
        state: z.string().optional().describe("Exact state name. When omitted, finished items are left out."),
        includeClosed: z.boolean().default(false).describe("Include Closed, Done and Removed items."),
        text: z.string().optional().describe("Text the title must contain."),
        tags: z.array(z.string()).optional().describe("Tags the work item must all have."),
        areaPath: z.string().optional().describe("Area path; items under it match too."),
        iterationPath: z.string().optional().describe("Iteration path; items under it match too."),
        currentIteration: z.boolean().default(false).describe("Only items in the team's current sprint."),
        team: z.string().optional().describe("Team whose current sprint `currentIteration` uses."),
        changedInLastDays: z.number().int().positive().optional(),
        top: z.number().int().min(1).max(1000).default(50),
      },
      annotations: READ,
    },
    (input) =>
      run(async () => {
        const project = client.optionalProject(input.project);
        const clauses: string[] = [];
        if (project) clauses.push("[System.TeamProject] = @project");
        if (input.assignedTo) {
          clauses.push(
            `[System.AssignedTo] = ${input.assignedTo.toLowerCase() === "@me" ? "@Me" : wiqlString(input.assignedTo)}`,
          );
        }
        if (input.type) clauses.push(`[System.WorkItemType] = ${wiqlString(input.type)}`);
        if (input.state) clauses.push(`[System.State] = ${wiqlString(input.state)}`);
        else if (!input.includeClosed) clauses.push(`[System.State] NOT IN (${CLOSED_STATES.map(wiqlString).join(", ")})`);
        if (input.text) clauses.push(`[System.Title] CONTAINS ${wiqlString(input.text)}`);
        for (const tag of input.tags ?? []) clauses.push(`[System.Tags] CONTAINS ${wiqlString(tag)}`);
        if (input.areaPath) clauses.push(`[System.AreaPath] UNDER ${wiqlString(input.areaPath)}`);
        if (input.iterationPath) clauses.push(`[System.IterationPath] UNDER ${wiqlString(input.iterationPath)}`);
        if (input.currentIteration) clauses.push("[System.IterationPath] = @CurrentIteration");
        if (input.changedInLastDays) clauses.push(`[System.ChangedDate] >= @Today - ${input.changedInLastDays}`);
        const wiql =
          `SELECT [System.Id] FROM WorkItems${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ` +
          "ORDER BY [System.ChangedDate] DESC";
        return { wiql, ...(await runWiql(client, wiql, input.top, project, input.team)) };
      }),
  );

  server.registerTool(
    "list_work_item_types",
    {
      title: "List work item types",
      description: "Lists the work item types of a project with their states, e.g. before creating or moving a work item.",
      inputSchema: { project: projectParam },
      annotations: READ,
    },
    ({ project }) =>
      run(async () => {
        const { value } = await client.get<{
          value: { name: string; description?: string; isDisabled?: boolean; states?: { name: string; category?: string }[] }[];
        }>(`/${seg(client.project(project))}/_apis/wit/workitemtypes`);
        return value
          .filter((t) => !t.isDisabled)
          .map((t) =>
            compact({
              name: t.name,
              description: t.description,
              states: t.states?.map((s) => (s.category ? `${s.name} (${s.category})` : s.name)),
            }),
          );
      }),
  );

  if (readOnly) return;

  server.registerTool(
    "create_work_item",
    {
      title: "Create work item",
      description: "Creates a work item (bug, task, user story, ...), optionally as the child of another work item.",
      inputSchema: {
        project: projectParam,
        type: z.string().min(1).describe("Work item type, e.g. Bug, Task, User Story. See list_work_item_types."),
        ...editableShape,
        title: z.string().min(1),
        parentId: z.number().int().positive().optional().describe("ID of the work item to add this one under."),
      },
      annotations: WRITE,
    },
    ({ project, type, parentId, ...fields }) =>
      run(async () => {
        const operations = fieldOperations(fields);
        if (parentId) operations.push(linkOperation(client, LINK_TYPES.parent, parentId));
        const item = await client.jsonPatch<WorkItem>(
          "POST",
          `/${seg(client.project(project))}/_apis/wit/workitems/$${seg(type)}`,
          operations,
        );
        return { created: summarizeWorkItem(item, client.orgUrl) };
      }),
  );

  server.registerTool(
    "update_work_item",
    {
      title: "Update work item",
      description:
        "Changes fields of a work item: title, state, assignee, description, tags, iteration, any other field. " +
        "Only the given fields change. Can also add a discussion comment in the same revision.",
      inputSchema: {
        id: z.number().int().positive(),
        ...editableShape,
        removeFields: z.array(z.string()).optional().describe("Reference names of fields to clear."),
        comment: z.string().optional().describe("Discussion comment to add with this change. Plain text unless `html` is true."),
      },
      annotations: OVERWRITE,
    },
    ({ id, removeFields, comment, ...fields }) =>
      run(async () => {
        const operations = fieldOperations(fields);
        for (const name of removeFields ?? []) operations.push({ op: "remove", path: `/fields/${name}` });
        if (comment) {
          operations.push({ op: "add", path: "/fields/System.History", value: fields.html ? comment : textToHtml(comment) });
        }
        if (operations.length === 0) throw new AzureDevOpsError("Nothing to update: give at least one field.");
        const item = await client.jsonPatch<WorkItem>("PATCH", `/_apis/wit/workitems/${id}`, operations);
        return { updated: summarizeWorkItem(item, client.orgUrl), revision: item.rev };
      }),
  );

  server.registerTool(
    "add_work_item_comment",
    {
      title: "Comment on work item",
      description: "Adds a comment to the discussion of a work item.",
      inputSchema: {
        id: z.number().int().positive(),
        text: z.string().min(1).describe("Comment text. Plain text unless `html` is true."),
        html: z.boolean().default(false),
      },
      annotations: WRITE,
    },
    ({ id, text, html }) =>
      run(async () => {
        const item = await client.jsonPatch<WorkItem>("PATCH", `/_apis/wit/workitems/${id}`, [
          { op: "add", path: "/fields/System.History", value: html ? text : textToHtml(text) },
        ]);
        return { commented: summarizeWorkItem(item, client.orgUrl), revision: item.rev };
      }),
  );

  server.registerTool(
    "link_work_items",
    {
      title: "Link work items",
      description:
        "Links two work items. linkType says what the target is to the source: \"parent\" makes the target " +
        "the parent of the source, \"child\" makes it a child, and so on.",
      inputSchema: {
        sourceId: z.number().int().positive(),
        targetId: z.number().int().positive(),
        linkType: z.enum(Object.keys(LINK_TYPES) as [keyof typeof LINK_TYPES, ...(keyof typeof LINK_TYPES)[]]),
        comment: z.string().optional(),
      },
      annotations: WRITE,
    },
    ({ sourceId, targetId, linkType, comment }) =>
      run(async () => {
        const item = await client.jsonPatch<WorkItem>("PATCH", `/_apis/wit/workitems/${sourceId}`, [
          linkOperation(client, LINK_TYPES[linkType], targetId, comment),
        ]);
        return { linked: `${targetId} is now the ${linkType} of ${sourceId}`, source: summarizeWorkItem(item, client.orgUrl) };
      }),
  );
}
