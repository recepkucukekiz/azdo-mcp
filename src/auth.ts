import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AzureDevOpsError, errorMessage } from "./errors.ts";

const execFileAsync = promisify(execFile);

/** Returns the value of the Authorization header for the next request. */
export type AuthProvider = () => Promise<string>;

/** Microsoft Entra resource ID of Azure DevOps. */
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const REFRESH_MARGIN_MS = 5 * 60_000;

export function patAuth(pat: string): AuthProvider {
  const header = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
  return async () => header;
}

/** Uses the signed-in Azure CLI (`az login`) to get short-lived Entra ID tokens. */
export function azureCliAuth(): AuthProvider {
  let cached: CliToken | undefined;
  let pending: Promise<CliToken> | undefined;
  return async () => {
    if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.header;
    pending ??= fetchCliToken().finally(() => {
      pending = undefined;
    });
    cached = await pending;
    return cached.header;
  };
}

interface CliToken {
  header: string;
  expiresAt: number;
}

async function fetchCliToken(): Promise<CliToken> {
  const args = ["account", "get-access-token", "--resource", AZURE_DEVOPS_RESOURCE, "--output", "json"];
  // az is a .cmd script on Windows, which can only be started through cmd.exe.
  const [file, fileArgs] =
    process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", "az", ...args]] : ["az", args];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(file, fileArgs, { timeout: 60_000, windowsHide: true }));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim().split("\n")[0];
    throw new AzureDevOpsError(
      "AZURE_DEVOPS_PAT is not set and no token could be obtained from the Azure CLI. " +
        `Set AZURE_DEVOPS_PAT, or install the Azure CLI and run \`az login\`. (${stderr || errorMessage(err)})`,
      401,
    );
  }
  const token = JSON.parse(stdout) as { accessToken: string; expires_on?: number | string; expiresOn?: string };
  const expiresAt = token.expires_on
    ? Number(token.expires_on) * 1000
    : Date.parse(token.expiresOn ?? "") || Date.now() + 30 * 60_000;
  return { header: `Bearer ${token.accessToken}`, expiresAt };
}
