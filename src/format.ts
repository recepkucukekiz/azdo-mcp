const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Converts the HTML Azure DevOps stores in rich text fields and comments to readable plain text. */
export function htmlToText(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|blockquote|pre)>/gi, "\n")
    .replace(/<img[^>]*\bsrc="([^"]*)"[^>]*>/gi, "[image: $1]")
    .replace(/<a[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const plain = label.replace(/<[^>]+>/g, "").trim();
      if (!plain) return href;
      return href.startsWith("#") || plain === href ? plain : `${plain} (${href})`;
    })
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try {
        return String.fromCodePoint(point);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Turns plain text into the HTML that rich text fields and comments expect. */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, "<br>");
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated, ${text.length - max} more characters]`;
}

interface Identity {
  displayName?: string;
  uniqueName?: string;
}

/** "Jane Doe <jane@contoso.com>" for an identity object, or the value itself when it is a string. */
export function identityName(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (!value || typeof value !== "object") return undefined;
  const { displayName, uniqueName } = value as Identity;
  if (displayName && uniqueName?.includes("@") && uniqueName !== displayName) return `${displayName} <${uniqueName}>`;
  return displayName ?? uniqueName;
}

export function shortRef(ref: string | undefined): string | undefined {
  return ref?.replace(/^refs\/heads\//, "");
}

export function branchRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/** Removes undefined, null, empty-string and empty-array values so responses stay small. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[key] = v;
  }
  return out as Partial<T>;
}

/** Trims a project name and undoes URL encoding, so "Web%20App" and "Web App" both work. */
export function plainName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/%[0-9a-f]{2}/i.test(trimmed)) return trimmed;
  try {
    return decodeURIComponent(trimmed).trim() || undefined;
  } catch {
    return trimmed;
  }
}

/** Quotes a value for use in a WIQL query. */
export function wiqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
