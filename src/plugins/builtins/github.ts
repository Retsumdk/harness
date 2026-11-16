import { ToolError } from "../../tools/registry";
import type { ConfigField, PluginManifest, PluginToolSpec } from "../types";
import type { PluginImplementation, PluginRuntime } from "../service";

const TOKEN: ConfigField = {
  name: "token",
  type: "string",
  required: true,
  secret: true,
  description: "Personal access token with repository read access. Stored server-side and never returned by the API.",
};

const TOOLS: PluginToolSpec[] = [
  {
    name: "github.get_repo",
    description: "Read metadata for a repository, e.g. owner \"octocat\", repo \"hello-world\".",
    schema: {
      type: "object",
      properties: { owner: { type: "string", maxLength: 100 }, repo: { type: "string", maxLength: 100 } },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github.create_issue",
    description: "Open an issue on a repository.",
    schema: {
      type: "object",
      properties: {
        owner: { type: "string", maxLength: 100 },
        repo: { type: "string", maxLength: 100 },
        title: { type: "string", maxLength: 200 },
        body: { type: "string", maxLength: 10000 },
      },
      required: ["owner", "repo", "title"],
    },
  },
];

const SLUG_RE = /^[A-Za-z0-9._-]{1,100}$/;

const requireSlug = (label: string, v: unknown): string => {
  if (typeof v !== "string" || !SLUG_RE.test(v) || v === "." || v === "..")
    throw new ToolError("invalid_args", `"${label}" must use letters, digits, dot, dash or underscore`);
  return v;
};

export function githubPlugin(opts: { apiBase?: string } = {}): PluginImplementation {
  const base = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");

  const call = async (rt: PluginRuntime, path: string, init?: RequestInit) => {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${String(rt.config.token)}`,
      "user-agent": "harness-plugin",
      "x-github-api-version": "2022-11-28",
    };
    if (init?.body) headers["content-type"] = "application/json";
    const res = await rt.fetch(`${base}${path}`, { ...init, headers });
    if (!res.ok) throw new ToolError("failed", `GitHub responded ${res.status} for ${path}`);
    return (await res.json()) as Record<string, any>;
  };

  const manifest: PluginManifest = {
    id: "github",
    name: "GitHub",
    version: "1.0.0",
    description: "Read repositories and open issues with a personal access token.",
    permissions: ["network", "secrets"],
    config: [TOKEN],
    tools: TOOLS,
  };

  return {
    manifest,
    handlers: {
      "github.get_repo": async (args, rt) => {
        const owner = requireSlug("owner", args.owner);
        const repo = requireSlug("repo", args.repo);
        const r = await call(rt, `/repos/${owner}/${repo}`);
        return {
          fullName: r.full_name,
          description: r.description ?? "",
          defaultBranch: r.default_branch,
          stars: r.stargazers_count ?? 0,
          openIssues: r.open_issues_count ?? 0,
          private: Boolean(r.private),
          url: r.html_url,
        };
      },
      "github.create_issue": async (args, rt) => {
        const owner = requireSlug("owner", args.owner);
        const repo = requireSlug("repo", args.repo);
        const title = args.title;
        if (typeof title !== "string" || !title.trim()) throw new ToolError("invalid_args", `"title" must be a non-empty string`);
        const body = typeof args.body === "string" ? args.body : "";
        const r = await call(rt, `/repos/${owner}/${repo}/issues`, {
          method: "POST",
          body: JSON.stringify({ title: title.slice(0, 200), body: body.slice(0, 10000) }),
        });
        return { number: r.number, title: r.title, state: r.state, url: r.html_url };
      },
    },
  };
}
