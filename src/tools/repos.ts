import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AzureDevOpsClient, seg } from "../client.ts";
import { AzureDevOpsError } from "../errors.ts";
import { branchRef, compact, identityName, plainName, shortRef, truncate } from "../format.ts";
import { projectParam, READ, run, type ToolContext, WRITE } from "./common.ts";
import { fetchSummaries } from "./workItems.ts";

interface IdentityRef {
  id?: string;
  displayName?: string;
  uniqueName?: string;
}

interface Reviewer extends IdentityRef {
  vote: number;
  isRequired?: boolean;
  hasDeclined?: boolean;
}

interface Repository {
  id: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
  isDisabled?: boolean;
  project: { id: string; name: string };
}

interface PullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  isDraft?: boolean;
  createdBy?: IdentityRef;
  creationDate?: string;
  closedDate?: string;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: string;
  reviewers?: Reviewer[];
  labels?: { name: string; active?: boolean }[];
  repository: Repository;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
  autoCompleteSetBy?: IdentityRef;
}

interface Thread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  publishedDate?: string;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number };
    leftFileStart?: { line: number };
  } | null;
  comments: {
    id: number;
    parentCommentId?: number;
    author?: IdentityRef;
    content?: string;
    publishedDate?: string;
    commentType?: string;
    isDeleted?: boolean;
  }[];
}

interface GitItem {
  path: string;
  isFolder?: boolean;
  gitObjectType?: string;
  content?: string;
  commitId?: string;
}

const VOTES: Record<string, string> = {
  "10": "approved",
  "5": "approved with suggestions",
  "0": "no vote",
  "-5": "waiting for author",
  "-10": "rejected",
};

/** Thread status values the API accepts when creating a thread. */
const THREAD_STATUS = { active: 1, fixed: 2, wontFix: 3, closed: 4, byDesign: 5, pending: 6 } as const;
type ThreadStatus = keyof typeof THREAD_STATUS;
const threadStatusNames = Object.keys(THREAD_STATUS) as [ThreadStatus, ...ThreadStatus[]];

const FILE_LIMIT = 100_000;

export function describeReviewer(reviewer: Reviewer): string {
  const flags = [reviewer.isRequired && "required", reviewer.hasDeclined && "declined"].filter(Boolean);
  const vote = VOTES[String(reviewer.vote)] ?? `vote ${reviewer.vote}`;
  return `${identityName(reviewer) ?? "unknown"}: ${vote}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

function pullRequestWebUrl(orgUrl: string, pr: PullRequest): string {
  return `${orgUrl}/${seg(pr.repository.project.name)}/_git/${seg(pr.repository.name)}/pullrequest/${pr.pullRequestId}`;
}

function summarizePullRequest(pr: PullRequest, orgUrl: string): Record<string, unknown> {
  return compact({
    id: pr.pullRequestId,
    title: pr.title,
    status: pr.status,
    isDraft: pr.isDraft || undefined,
    repository: pr.repository.name,
    project: pr.repository.project.name,
    author: identityName(pr.createdBy),
    created: pr.creationDate,
    closed: pr.closedDate,
    source: shortRef(pr.sourceRefName),
    target: shortRef(pr.targetRefName),
    mergeStatus: pr.mergeStatus,
    reviewers: pr.reviewers?.map(describeReviewer),
    url: pullRequestWebUrl(orgUrl, pr),
  });
}

function getPullRequest(client: AzureDevOpsClient, id: number, project?: string): Promise<PullRequest> {
  // Pull request IDs are unique in the organization, so the project is only needed to narrow the lookup.
  const scope = plainName(project);
  return client.get<PullRequest>(`${scope ? `/${seg(scope)}` : ""}/_apis/git/pullrequests/${id}`);
}

/** Base path of a pull request's sub-resources (threads, iterations, work items). */
function pullRequestPath(pr: PullRequest): string {
  return `/${seg(pr.repository.project.name)}/_apis/git/repositories/${pr.repository.id}/pullRequests/${pr.pullRequestId}`;
}

function versionQuery(version: string | undefined, versionType: string | undefined): Record<string, string | undefined> {
  return {
    "versionDescriptor.version": version,
    "versionDescriptor.versionType": version ? (versionType ?? "branch") : undefined,
  };
}

const repositoryParam = z.string().min(1).describe("Repository name or ID.");
const versionParams = {
  version: z.string().optional().describe("Branch name, commit SHA or tag. Defaults to the default branch."),
  versionType: z.enum(["branch", "commit", "tag"]).optional().describe("What `version` is. Defaults to branch."),
};

export function registerRepoTools(server: McpServer, { client, readOnly }: ToolContext): void {
  server.registerTool(
    "list_repositories",
    {
      title: "List repositories",
      description: "Lists the Git repositories of a project, or of the whole organization when no project is set.",
      inputSchema: { project: projectParam },
      annotations: READ,
    },
    ({ project }) =>
      run(async () => {
        const scope = client.optionalProject(project);
        const { value } = await client.get<{ value: Repository[] }>(
          `${scope ? `/${seg(scope)}` : ""}/_apis/git/repositories`,
        );
        return value.map((r) =>
          compact({
            name: r.name,
            id: r.id,
            project: r.project.name,
            defaultBranch: shortRef(r.defaultBranch),
            disabled: r.isDisabled || undefined,
            url: r.webUrl,
          }),
        );
      }),
  );

  server.registerTool(
    "list_pull_requests",
    {
      title: "List pull requests",
      description:
        "Lists pull requests of a project or one repository. Use mine to get the signed-in user's own " +
        "pull requests or the ones waiting on their review.",
      inputSchema: {
        project: projectParam,
        repository: repositoryParam.optional().describe("Repository name or ID. All repositories when omitted."),
        status: z.enum(["active", "completed", "abandoned", "all"]).default("active"),
        mine: z.enum(["created", "reviewing"]).optional().describe("created: authored by me; reviewing: I am a reviewer."),
        targetBranch: z.string().optional().describe("Only pull requests into this branch, e.g. main."),
        sourceBranch: z.string().optional(),
        top: z.number().int().min(1).max(500).default(30),
      },
      annotations: READ,
    },
    ({ project, repository, status, mine, targetBranch, sourceBranch, top }) =>
      run(async () => {
        const scope = `/${seg(client.project(project))}`;
        const path = repository
          ? `${scope}/_apis/git/repositories/${seg(repository)}/pullrequests`
          : `${scope}/_apis/git/pullrequests`;
        const me = mine ? await client.getCurrentUser() : undefined;
        const { value } = await client.get<{ value: PullRequest[] }>(path, {
          query: {
            "searchCriteria.status": status,
            "searchCriteria.creatorId": mine === "created" ? me?.id : undefined,
            "searchCriteria.reviewerId": mine === "reviewing" ? me?.id : undefined,
            "searchCriteria.targetRefName": targetBranch ? branchRef(targetBranch) : undefined,
            "searchCriteria.sourceRefName": sourceBranch ? branchRef(sourceBranch) : undefined,
            $top: top,
          },
        });
        return value.map((pr) => summarizePullRequest(pr, client.orgUrl));
      }),
  );

  server.registerTool(
    "get_pull_request",
    {
      title: "Get pull request",
      description:
        "Gets a pull request by ID with its description, reviewers and votes, merge status, commits and linked work items.",
      inputSchema: {
        id: z.number().int().positive().describe("Pull request ID."),
        project: z.string().optional().describe("Project name or ID. Not needed: pull request IDs are unique in the organization."),
      },
      annotations: READ,
    },
    ({ id, project }) =>
      run(async () => {
        const pr = await getPullRequest(client, id, project);
        const { value: links } = await client.get<{ value: { id: string }[] }>(`${pullRequestPath(pr)}/workitems`);
        return compact({
          ...summarizePullRequest(pr, client.orgUrl),
          description: pr.description ? truncate(pr.description, 20_000) : undefined,
          labels: pr.labels?.filter((l) => l.active !== false).map((l) => l.name),
          autoComplete: pr.autoCompleteSetBy ? `set by ${identityName(pr.autoCompleteSetBy)}` : undefined,
          sourceCommit: pr.lastMergeSourceCommit?.commitId,
          targetCommit: pr.lastMergeTargetCommit?.commitId,
          workItems: await fetchSummaries(client, links.map((l) => Number(l.id))),
        });
      }),
  );

  server.registerTool(
    "get_pull_request_changes",
    {
      title: "Get pull request changes",
      description:
        "Lists the files a pull request adds, edits, deletes or renames, with the source and target commits. " +
        "Read a file's contents at either commit with get_file_content (versionType commit) to review the change.",
      inputSchema: {
        id: z.number().int().positive().describe("Pull request ID."),
        project: z.string().optional(),
      },
      annotations: READ,
    },
    ({ id, project }) =>
      run(async () => {
        const pr = await getPullRequest(client, id, project);
        const { value: iterations } = await client.get<{ value: { id: number }[] }>(`${pullRequestPath(pr)}/iterations`);
        const last = iterations.at(-1);
        if (!last) return { files: [] };
        const { changeEntries } = await client.get<{
          changeEntries: { changeType: string; item?: GitItem; originalPath?: string }[];
        }>(`${pullRequestPath(pr)}/iterations/${last.id}/changes`, { query: { $top: 2000 } });
        return {
          repository: pr.repository.name,
          project: pr.repository.project.name,
          iteration: last.id,
          sourceCommit: pr.lastMergeSourceCommit?.commitId,
          targetCommit: pr.lastMergeTargetCommit?.commitId,
          files: changeEntries
            .filter((c) => c.item && !c.item.isFolder && c.item.gitObjectType !== "tree")
            .map((c) => compact({ path: c.item?.path, change: c.changeType, from: c.originalPath })),
        };
      }),
  );

  server.registerTool(
    "list_pull_request_threads",
    {
      title: "List pull request comments",
      description: "Lists the comment threads of a pull request, including file and line for code comments.",
      inputSchema: {
        id: z.number().int().positive().describe("Pull request ID."),
        project: z.string().optional(),
        status: z.enum(["active", "fixed", "wontFix", "closed", "byDesign", "pending", "all"]).default("all"),
        includeSystem: z.boolean().default(false).describe("Include automatic comments such as votes and pushes."),
      },
      annotations: READ,
    },
    ({ id, project, status, includeSystem }) =>
      run(async () => {
        const pr = await getPullRequest(client, id, project);
        const { value } = await client.get<{ value: Thread[] }>(`${pullRequestPath(pr)}/threads`);
        return value.flatMap((thread) => {
          if (thread.isDeleted) return [];
          if (status !== "all" && thread.status !== status) return [];
          const comments = thread.comments.filter(
            (c) => !c.isDeleted && (includeSystem || c.commentType !== "system"),
          );
          if (comments.length === 0) return [];
          const context = thread.threadContext;
          return [
            compact({
              threadId: thread.id,
              status: thread.status,
              file: context?.filePath,
              line: context?.rightFileStart?.line ?? context?.leftFileStart?.line,
              comments: comments.map((c) =>
                compact({
                  id: c.id,
                  replyTo: c.parentCommentId || undefined,
                  author: identityName(c.author),
                  date: c.publishedDate,
                  text: truncate(c.content ?? "", 4000),
                }),
              ),
            }),
          ];
        });
      }),
  );

  server.registerTool(
    "get_file_content",
    {
      title: "Get file content",
      description: "Reads a file from a Git repository at a branch, commit or tag.",
      inputSchema: {
        project: projectParam,
        repository: repositoryParam,
        path: z.string().min(1).describe("File path in the repository, e.g. /src/app.ts."),
        ...versionParams,
        startLine: z.number().int().positive().optional().describe("First line to return (1-based)."),
        endLine: z.number().int().positive().optional().describe("Last line to return."),
      },
      annotations: READ,
    },
    ({ project, repository, path, version, versionType, startLine, endLine }) =>
      run(async () => {
        const item = await client.get<GitItem>(
          `/${seg(client.project(project))}/_apis/git/repositories/${seg(repository)}/items`,
          { query: { path, includeContent: true, $format: "json", ...versionQuery(version, versionType) } },
        );
        if (item.isFolder || item.gitObjectType === "tree") {
          throw new AzureDevOpsError(`${path} is a folder. Use list_repository_items to see what it contains.`);
        }
        const content = item.content ?? "";
        if (content.includes("\u0000")) return `${item.path} is a binary file and is not shown.`;
        let text = content;
        let range = "";
        if (startLine || endLine) {
          const lines = content.split("\n");
          const from = Math.max(1, startLine ?? 1);
          const to = Math.min(lines.length, endLine ?? lines.length);
          text = lines.slice(from - 1, to).join("\n");
          range = ` lines ${from}-${to} of ${lines.length}`;
        }
        return `${item.path}${range} @ ${item.commitId ?? version ?? "default branch"}\n\n${truncate(text, FILE_LIMIT)}`;
      }),
  );

  server.registerTool(
    "list_repository_items",
    {
      title: "List repository files",
      description: "Lists files and folders in a Git repository folder, optionally recursively.",
      inputSchema: {
        project: projectParam,
        repository: repositoryParam,
        path: z.string().default("/").describe("Folder path, e.g. / or /src."),
        recursive: z.boolean().default(false),
        ...versionParams,
      },
      annotations: READ,
    },
    ({ project, repository, path, recursive, version, versionType }) =>
      run(async () => {
        const { value } = await client.get<{ value: GitItem[] }>(
          `/${seg(client.project(project))}/_apis/git/repositories/${seg(repository)}/items`,
          {
            query: {
              scopePath: path,
              recursionLevel: recursive ? "Full" : "OneLevel",
              ...versionQuery(version, versionType),
            },
          },
        );
        const scope = path.replace(/\/+$/, "") || "/";
        const items = value
          .filter((i) => i.path !== scope)
          .map((i) => (i.isFolder || i.gitObjectType === "tree" ? `${i.path}/` : i.path));
        const limit = 2000;
        return compact({
          count: items.length,
          items: items.slice(0, limit),
          note: items.length > limit ? `Showing the first ${limit}; list a subfolder for the rest.` : undefined,
        });
      }),
  );

  if (readOnly) return;

  server.registerTool(
    "create_pull_request",
    {
      title: "Create pull request",
      description: "Opens a pull request from one branch into another, optionally linking work items.",
      inputSchema: {
        project: projectParam,
        repository: repositoryParam,
        sourceBranch: z.string().min(1).describe("Branch with the changes, e.g. feature/login."),
        targetBranch: z.string().optional().describe("Branch to merge into. Defaults to the repository's default branch."),
        title: z.string().min(1),
        description: z.string().optional().describe("Description in Markdown."),
        isDraft: z.boolean().default(false),
        workItemIds: z.array(z.number().int().positive()).optional().describe("Work items to link to the pull request."),
      },
      annotations: WRITE,
    },
    ({ project, repository, sourceBranch, targetBranch, title, description, isDraft, workItemIds }) =>
      run(async () => {
        const repoPath = `/${seg(client.project(project))}/_apis/git/repositories/${seg(repository)}`;
        let target = targetBranch;
        if (!target) {
          target = (await client.get<Repository>(repoPath)).defaultBranch;
          if (!target) throw new AzureDevOpsError("The repository has no default branch; give targetBranch.");
        }
        const pr = await client.post<PullRequest>(`${repoPath}/pullrequests`, {
          sourceRefName: branchRef(sourceBranch),
          targetRefName: branchRef(target),
          title,
          description,
          isDraft,
          workItemRefs: workItemIds?.map((id) => ({ id: String(id) })),
        });
        return { created: summarizePullRequest(pr, client.orgUrl) };
      }),
  );

  server.registerTool(
    "add_pull_request_comment",
    {
      title: "Comment on pull request",
      description:
        "Adds a comment to a pull request: a new general comment, a comment on a file line, or a reply to an existing thread.",
      inputSchema: {
        id: z.number().int().positive().describe("Pull request ID."),
        content: z.string().min(1).describe("Comment text in Markdown."),
        project: z.string().optional(),
        threadId: z.number().int().positive().optional().describe("Reply in this thread instead of starting a new one."),
        filePath: z.string().optional().describe("Start the thread on this file, e.g. /src/app.ts."),
        line: z.number().int().positive().optional().describe("Line in the new version of filePath."),
        status: z.enum(threadStatusNames).default("active").describe("Status of a new thread."),
      },
      annotations: WRITE,
    },
    ({ id, content, project, threadId, filePath, line, status }) =>
      run(async () => {
        const pr = await getPullRequest(client, id, project);
        if (threadId) {
          const comment = await client.post<{ id: number }>(`${pullRequestPath(pr)}/threads/${threadId}/comments`, {
            content,
            parentCommentId: 1,
            commentType: 1,
          });
          return { replied: { threadId, commentId: comment.id }, pullRequest: pullRequestWebUrl(client.orgUrl, pr) };
        }
        if (line && !filePath) throw new AzureDevOpsError("`line` needs `filePath` as well.");
        const file = filePath ? `/${filePath.replace(/^\/+/, "")}` : undefined;
        const thread = await client.post<Thread>(`${pullRequestPath(pr)}/threads`, {
          comments: [{ parentCommentId: 0, content, commentType: 1 }],
          status: THREAD_STATUS[status],
          threadContext: file
            ? compact({
                filePath: file,
                rightFileStart: line ? { line, offset: 1 } : undefined,
                rightFileEnd: line ? { line, offset: 1 } : undefined,
              })
            : undefined,
        });
        return { created: { threadId: thread.id, file, line }, pullRequest: pullRequestWebUrl(client.orgUrl, pr) };
      }),
  );
}
