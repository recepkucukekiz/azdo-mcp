# azdo-mcp

An [MCP](https://modelcontextprotocol.io) server that connects Claude to **Azure DevOps**: give Claude a work item or pull request number and it can read it, find related work, comment, update fields and open pull requests.

It runs locally over stdio and works with Claude Code, Claude Desktop and any other MCP client.

```
> What is bug 4821 about, and is anyone working on it?
> List my active work items in the current sprint.
> Review PR 312 and leave comments on anything risky.
> Create a task under story 4790 for the Safari login fix and assign it to me.
```

## Tools

**Work items**

| Tool | What it does |
| --- | --- |
| `get_work_item` | One work item with description, acceptance criteria, links (parent, children, PRs) and discussion comments |
| `get_work_items` | Short summaries of many work items at once |
| `find_work_items` | Search by assignee (`@Me`), type, state, title text, tags, area, iteration or current sprint |
| `query_work_items` | Run any WIQL query |
| `list_work_item_types` | Work item types of a project and their states |
| `create_work_item` ✏️ | Create a work item, optionally under a parent |
| `update_work_item` ✏️ | Change any fields and optionally add a comment in the same revision |
| `add_work_item_comment` ✏️ | Add a discussion comment |
| `link_work_items` ✏️ | Link as parent, child, related, predecessor, successor or duplicate |

**Repositories and pull requests**

| Tool | What it does |
| --- | --- |
| `list_projects` | Projects in the organization |
| `list_repositories` | Git repositories of a project or the organization |
| `list_pull_requests` | Pull requests by status, branch, or `mine: created / reviewing` |
| `get_pull_request` | Description, reviewers and votes, merge status, commits, linked work items |
| `get_pull_request_changes` | Files the pull request changes, with source and target commits |
| `list_pull_request_threads` | Comment threads, with file and line for code comments |
| `get_file_content` | A file (or a line range of it) at a branch, commit or tag |
| `list_repository_items` | Files and folders of a repository path |
| `create_pull_request` ✏️ | Open a pull request, optionally linking work items |
| `add_pull_request_comment` ✏️ | New comment, comment on a file line, or reply to a thread |

✏️ tools change data. They are not registered at all in [read-only mode](#read-only-mode).

## Setup

You need Node.js 20 or later and either a Personal Access Token or the Azure CLI.

### 1. Credentials

**Personal Access Token (PAT).** In Azure DevOps open *User settings → Personal access tokens → New token* and grant:

| Scope | Needed for |
| --- | --- |
| Work Items: Read & write | work item tools (Read is enough in read-only mode) |
| Code: Read & write | repository and pull request tools (Read is enough in read-only mode) |
| Project and Team: Read | `list_projects` |

**Azure CLI.** If `AZURE_DEVOPS_PAT` is not set, the server asks the Azure CLI for a token, so `az login` with an account that has access to the organization is all you need.

### 2. Add the server to Claude

**Claude Code**

```bash
claude mcp add azure-devops --scope user \
  --env AZURE_DEVOPS_PAT=<your-pat> \
  --env AZURE_DEVOPS_PROJECT=<default-project> \
  -- npx -y azdo-mcp <your-organization>
```

On Windows, start the command with `cmd /c`: `-- cmd /c npx -y azdo-mcp <your-organization>`. In PowerShell, also write the separator as `'--'` (in quotes): `claude` runs through the `claude.ps1` shim, and PowerShell drops a bare `--` before calling a script, which makes `claude` fail with `unknown option '-y'`.

**Claude Desktop** — *Settings → Developer → Edit Config* and add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "npx",
      "args": ["-y", "azdo-mcp", "<your-organization>"],
      "env": {
        "AZURE_DEVOPS_PAT": "<your-pat>",
        "AZURE_DEVOPS_PROJECT": "<default-project>"
      }
    }
  }
}
```

Until the package is published on npm, use `github:recepkucukekiz/azdo-mcp` in place of `azdo-mcp`, or point to a local build: `"command": "node", "args": ["C:/path/to/azdo-mcp/dist/index.js", "<your-organization>"]`.

## Configuration

| Setting | Description |
| --- | --- |
| first argument or `AZURE_DEVOPS_ORG` | Organization name (`contoso`) or URL (`https://dev.azure.com/contoso`). For Azure DevOps Server, the collection URL (`https://tfs.contoso.com/tfs/DefaultCollection`). |
| `AZURE_DEVOPS_PAT` | Personal Access Token. When unset, the Azure CLI is used. |
| `AZURE_DEVOPS_PROJECT` | Default project, so tools can be called without `project`. |
| `AZURE_DEVOPS_READ_ONLY` or `--read-only` | `true` to register only the tools that read. |

### Read-only mode

With `AZURE_DEVOPS_READ_ONLY=true` (or the `--read-only` argument) the tools that create or change anything are not offered to the model at all. Use it together with a read-only PAT when you only want Claude to look things up.

## Development

```bash
npm install
npm run build
npm test
```

`npm run dev -- <org>` runs the server from source (Node 22.18+ runs the TypeScript directly). The tests start the tools through a real MCP client against a fake Azure DevOps API, so they need no account.

To try the server interactively, use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/index.js <your-organization>
```

## Security notes

- The PAT gives the model whatever access the token has. Prefer short-lived tokens with only the scopes above, and read-only mode where you can.
- Text from work items, comments and files is shown to the model as data. Like any tool that reads content other people write, it can contain instructions aimed at the model; keep write tools behind your client's tool approval.

## License

[MIT](LICENSE)
