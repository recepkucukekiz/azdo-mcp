import type { AuthProvider } from "./auth.ts";
import { AzureDevOpsError, errorMessage } from "./errors.ts";
import { plainName } from "./format.ts";

const DEFAULT_API_VERSION = "7.1";
const TIMEOUT_MS = 30_000;

type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  contentType?: string;
  /** Defaults to 7.1; null sends no api-version parameter. */
  apiVersion?: string | null;
}

export interface CurrentUser {
  id: string;
  displayName: string;
}

/** Encodes one URL path segment (project, repository, team or type name). */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

export class AzureDevOpsClient {
  readonly orgUrl: string;
  readonly defaultProject: string | undefined;
  private readonly auth: AuthProvider;
  private currentUser: Promise<CurrentUser> | undefined;

  constructor(orgUrl: string, auth: AuthProvider, defaultProject?: string) {
    this.orgUrl = orgUrl;
    this.auth = auth;
    this.defaultProject = plainName(defaultProject);
  }

  /** The given project, or the configured default; throws when there is neither. */
  project(project?: string): string {
    const resolved = this.optionalProject(project);
    if (!resolved) {
      throw new AzureDevOpsError("No project given. Pass `project` or set AZURE_DEVOPS_PROJECT.");
    }
    return resolved;
  }

  /** The given project or the configured default, if any. */
  optionalProject(project?: string): string | undefined {
    return plainName(project) ?? this.defaultProject;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  /** Sends a JSON Patch document, as the work item endpoints expect. */
  jsonPatch<T>(method: "POST" | "PATCH", path: string, operations: unknown[]): Promise<T> {
    return this.request<T>(method, path, { body: operations, contentType: "application/json-patch+json" });
  }

  getCurrentUser(): Promise<CurrentUser> {
    this.currentUser ??= this.get<{ authenticatedUser: { id: string; providerDisplayName: string } }>(
      "/_apis/connectionData",
      { apiVersion: null },
    ).then(
      ({ authenticatedUser }) => ({ id: authenticatedUser.id, displayName: authenticatedUser.providerDisplayName }),
      (err) => {
        this.currentUser = undefined;
        throw err;
      },
    );
    return this.currentUser;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.orgUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const apiVersion = options.apiVersion === undefined ? DEFAULT_API_VERSION : options.apiVersion;
    if (apiVersion) url.searchParams.set("api-version", apiVersion);

    const headers: Record<string, string> = { Authorization: await this.auth(), Accept: "application/json" };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/json";
      body = JSON.stringify(options.body);
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new AzureDevOpsError(`Request to ${url.host} failed: ${errorMessage(err)}`);
    }

    // An invalid PAT is answered with a redirect to the sign-in page rather than a 401.
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status === 203 || (res.ok && contentType.includes("text/html"))) {
      throw new AzureDevOpsError(
        "Azure DevOps answered with a sign-in page: the credentials were not accepted. Check AZURE_DEVOPS_PAT or `az login`.",
        401,
      );
    }
    const text = await res.text();
    if (!res.ok) throw new AzureDevOpsError(describeFailure(res.status, text), res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function describeFailure(status: number, body: string): string {
  let message: string;
  try {
    message = (JSON.parse(body) as { message?: string }).message ?? "";
  } catch {
    message = body.slice(0, 300);
  }
  const hints: Record<number, string> = {
    401: "Check that the PAT is valid and not expired.",
    403: "The PAT or account may be missing the required scope or permission.",
    404: "Check the organization, project, repository and ID.",
  };
  return [`Azure DevOps API error ${status}${message ? `: ${message.trim()}` : ""}`, hints[status]]
    .filter(Boolean)
    .join(" ");
}
