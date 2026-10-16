import { AzureDevOpsError } from "./errors.ts";

export interface Config {
  /** Organization (or on-premises collection) URL without a trailing slash. */
  orgUrl: string;
  defaultProject: string | undefined;
  pat: string | undefined;
  readOnly: boolean;
}

/** Accepts an organization name ("contoso") or a full URL and returns the base URL. */
export function normalizeOrgUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(value)) return value;
  if (!value || /[/\s]/.test(value)) {
    throw new AzureDevOpsError(`"${input}" is not an Azure DevOps organization name or URL.`);
  }
  return `https://dev.azure.com/${encodeURIComponent(value)}`;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2),
): Config {
  const org = args.find((arg) => !arg.startsWith("-")) ?? env.AZURE_DEVOPS_ORG_URL ?? env.AZURE_DEVOPS_ORG;
  if (!org?.trim()) {
    throw new AzureDevOpsError(
      "No organization configured. Pass it as the first argument (`azdo-mcp <org>`) or set AZURE_DEVOPS_ORG.",
    );
  }
  return {
    orgUrl: normalizeOrgUrl(org),
    defaultProject: env.AZURE_DEVOPS_PROJECT?.trim() || undefined,
    pat: env.AZURE_DEVOPS_PAT?.trim() || undefined,
    readOnly: args.includes("--read-only") || isTrue(env.AZURE_DEVOPS_READ_ONLY),
  };
}

function isTrue(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}
