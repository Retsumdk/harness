import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatView } from "../src/web/pages/Chat";
import { FilesView, createBase, createFolderLabel, pathFromSearch } from "../src/web/pages/Files";
import { AgentsView } from "../src/web/pages/Agents";
import { RunView } from "../src/web/pages/Runs";
import { PluginsView } from "../src/web/pages/Plugins";
import { SettingsView } from "../src/web/pages/Settings";
import { HomeView } from "../src/web/pages/Home";
import { NotFoundView } from "../src/web/pages/NotFound";
import { matchRoute, ROUTE_PATTERNS, RouterProvider } from "../src/web/router";
import type { ReactElement } from "react";
import type { Agent, AgentRun, Conversation, Message, ModuleView, PluginView, SettingsPayload } from "../src/web/api";

const html = (node: ReactElement) =>
  renderToStaticMarkup(<RouterProvider initial="/chat">{node}</RouterProvider>);

const conv = (id: string, title: string, createdAt = 1_700_000_000_000): Conversation => ({ id, title, createdAt });
const msg = (id: string, role: Message["role"], content: string): Message => ({
  id, conversationId: "conv_1", role, content, createdAt: 1_700_000_000_000,
});

const chatProps = {
  conversations: [] as Conversation[],
  activeId: null as string | null,
  messages: [] as Message[],
  loading: false,
  listing: false,
  streaming: false,
  streamText: "",
  error: null as string | null,
  listError: null as string | null,
  providers: ["mock"],
  provider: "mock",
  busy: false,
  onSend: () => undefined,
  onNew: () => undefined,
  onSelect: () => undefined,
  onDelete: () => undefined,
  onStop: () => undefined,
  onProviderChange: () => undefined,
  onRetry: () => undefined,
};

describe("web views — chat", () => {
  test("first run writes a real empty state, not a blank panel", () => {
    const out = html(<ChatView {...chatProps} />);
    expect(out).toContain("Nothing said yet");
    expect(out).toContain("No conversations yet");
    expect(out).toContain("Send the first message"); // the panel still offers a way forward
  });

  test("a selected conversation renders its messages with roles", () => {
    const out = html(
      <ChatView
        {...chatProps}
        conversations={[conv("c1", "Workspace tour")]}
        activeId="c1"
        messages={[msg("m1", "user", "What is in this workspace?"), msg("m2", "assistant", "Three files and a README.")]}
      />,
    );
    expect(out).toContain("Workspace tour");
    expect(out).toContain("What is in this workspace?");
    expect(out).toContain("Three files and a README.");
    expect(out).toContain("user");
    expect(out).toContain("assistant");
  });

  test("streaming text is shown while the reply is still arriving", () => {
    const out = html(
      <ChatView {...chatProps} conversations={[conv("c1", "Live")]} activeId="c1" streaming streamText="partial ans" />,
    );
    expect(out).toContain("partial ans");
    expect(out).toContain("is-streaming");
    expect(out).toContain("Stop");
  });

  test("a failed turn shows the server's message and a retry", () => {
    const out = html(
      <ChatView
        {...chatProps}
        conversations={[conv("c1", "Live")]}
        activeId="c1"
        error="provider_error: upstream 502"
      />,
    );
    expect(out).toContain("provider_error: upstream 502");
    expect(out).toContain("Retry");
  });

  test("a tool call is rendered with its name, not swallowed", () => {
    const withCall: Message = {
      ...msg("m3", "assistant", ""),
      toolCalls: [{ id: "call_1", name: "fs.list", args: { path: "." } }],
    };
    const out = html(
      <ChatView {...chatProps} conversations={[conv("c1", "Tools")]} activeId="c1" messages={[withCall]} />,
    );
    expect(out).toContain("fs.list");
  });

  test("suggestions exist so a first-time user does not face an empty box", () => {
    const out = html(<ChatView {...chatProps} />);
    expect(out).toContain("What is in this workspace?");
    expect(out).toContain("data/releases.csv");
  });
});

const filesProps = {
  path: ".",
  listing: null,
  loading: false,
  error: null as string | null,
  searchQuery: "",
  searchResults: null,
  searchLoading: false,
  draft: "",
  saving: false,
  notice: null as string | null,
  onOpenDir: () => undefined,
  onOpenFile: () => undefined,
  onSave: () => undefined,
  onDraft: () => undefined,
  onSearch: () => undefined,
  onClearSearch: () => undefined,
  onDelete: () => undefined,
  onCreate: () => undefined,
  creating: false,
  reload: () => undefined,
};

describe("web views — files", () => {
  test("loading is visible before the first listing arrives", () => {
    expect(html(<FilesView {...filesProps} loading />)).toContain("Reading workspace");
  });
  test("the subtitle is true in both kernels, including the in-tab demo", () => {
    // The server build keeps files on disk; the static demo keeps them in the tab.
    const out = html(<FilesView {...filesProps} listing={{ type: "dir", path: ".", entries: [] }} />);
    expect(out).toContain("Plain files");
    expect(out).not.toContain("on disk");
  });
  test("a `/files?path=` URL opens that folder, not the root", () => {
    expect(pathFromSearch(new URLSearchParams("?path=notes/2026"))).toBe("notes/2026");
    expect(pathFromSearch(new URLSearchParams("?path=%2E%2E"))).toBe("..");
  });

  test("creating a file while a file is open targets that file's folder, not the file", () => {
    // QA round 2, P1: the dialog used the open file's own path as the base, so with
    // README.md open the request was `PUT /api/files?path=README.md/probe.md` -> 500.
    const nested = { type: "file" as const, path: "data/notes/qa.md", content: "", size: 0 };
    expect(createBase("data/notes/qa.md", nested)).toBe("data/notes/");
    expect(createFolderLabel("data/notes/qa.md", nested)).toBe("data/notes");
    const atRoot = { type: "file" as const, path: "README.md", content: "", size: 0 };
    expect(createBase("README.md", atRoot)).toBe("");
    expect(createFolderLabel("README.md", atRoot)).toBe("the workspace root");
  });

  test("a directory is its own base, so create lands in the folder the page says", () => {
    const dir = { type: "dir" as const, path: "data/notes", entries: [] };
    expect(createBase("data/notes", dir)).toBe("data/notes/");
    expect(createFolderLabel("data/notes", dir)).toBe("data/notes");
    expect(createBase(".", null)).toBe("");
  });

  test("no path in the URL starts at the workspace root", () => {
    expect(pathFromSearch(new URLSearchParams(""))).toBe(".");
    expect(pathFromSearch(new URLSearchParams("?path="))).toBe(".");
    expect(pathFromSearch(new URLSearchParams("?path=%20%20"))).toBe(".");
  });

  test("a directory lists its entries with sizes", () => {
    const out = html(
      <FilesView
        {...filesProps}
        listing={{
          type: "dir",
          path: ".",
          entries: [
            { name: "notes", kind: "dir", path: "notes" },
            { name: "README.md", kind: "file", path: "README.md", size: 2048 },
          ],
        }}
      />,
    );
    expect(out).toContain("notes");
    expect(out).toContain("README.md");
    expect(out).toContain("2.0 KB");
  });

  test("an empty directory says so", () => {
    const out = html(<FilesView {...filesProps} listing={{ type: "dir", path: "empty", entries: [] }} />);
    expect(out).toContain("This folder is empty");
  });

  test("a missing path renders the server's error with a retry", () => {
    const out = html(<FilesView {...filesProps} error="no such path: ghost.md" />);
    expect(out).toContain("no such path: ghost.md");
    expect(out).toContain("Try again");
  });

  test("an open file is editable and offers a save", () => {
    const out = html(
      <FilesView
        {...filesProps}
        path="README.md"
        listing={{ type: "file", path: "README.md", content: "# Workspace", size: 11 }}
        draft="# Workspace"
      />,
    );
    expect(out).toContain("# Workspace");
    expect(out).toContain("Save");
  });

  test("a search with no matches writes an empty state", () => {
    const out = html(<FilesView {...filesProps} listing={{ type: "dir", path: ".", entries: [] }} searchQuery="zzz" searchResults={[]} />);
    expect(out).toContain("No matches");
  });
});

const agent = (id: string, name: string, runs: AgentRun[] = []): Agent => ({
  id, name, systemPrompt: "You are careful.", provider: "mock", tools: ["fs.read", "fs.list"],
  maxSteps: 6, maxTokens: 3000, createdAt: 1_700_000_000_000,
});

const agentsProps = {
  agents: [] as Agent[],
  runsByAgent: {},
  tools: ["fs.read", "fs.write"],
  loading: false,
  error: null as string | null,
  editor: null,
  editorError: null as string | null,
  saving: false,
  launching: false,
  notice: null as string | null,
  onNew: () => undefined,
  onEdit: () => undefined,
  onChange: () => undefined,
  onSave: () => undefined,
  onClose: () => undefined,
  onDelete: () => undefined,
  onRun: () => undefined,
  reload: () => undefined,
};

describe("web views — agents", () => {
  test("an empty roster explains what an agent is and offers the action", () => {
    const out = html(<AgentsView {...agentsProps} />);
    expect(out).toContain("No agents yet");
    expect(out).toContain("Create your first agent");
  });

  test("a card shows the tool allowlist and the budget", () => {
    const out = html(<AgentsView {...agentsProps} agents={[agent("a1", "Research Assistant")]} />);
    expect(out).toContain("Research Assistant");
    expect(out).toContain("fs.read");
    expect(out).toContain("6");
    expect(out).toContain("3000");
  });

  test("a validation failure from the server is shown next to the form", () => {
    const out = html(
      <AgentsView
        {...agentsProps}
        editor={{ name: "Bad", systemPrompt: "", model: "", tools: [], maxSteps: "0", maxTokens: "10" }}
        editorError="bad_request: &quot;maxSteps&quot; must be an integer between 1 and 50"
      />,
    );
    expect(out).toContain("maxSteps");
    expect(out).toContain("Create agent");
  });

  test("run history links to the run viewer with its status", () => {
    const run: AgentRun = {
      id: "run_1", agentId: "a1", status: "succeeded", input: "go", output: "done",
      steps: [], tokensUsed: 12, startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000,
    };
    const out = html(<AgentsView {...agentsProps} agents={[agent("a1", "Research Assistant")]} runsByAgent={{ a1: [run] }} />);
    expect(out).toContain("/runs/run_1");
    expect(out).toContain("succeeded");
  });
});

const runViewProps = {
  run: null,
  agentName: null,
  streaming: false,
  error: null as string | null,
  busy: false,
  onCancel: () => undefined,
  onRetry: () => undefined,
};

describe("web views — run viewer", () => {
  test("before the run loads it shows progress, not a blank page", () => {
    expect(html(<RunView {...runViewProps} />)).toContain("Loading run");
  });

  test("steps are rendered in order with their tool results", () => {
    const run: AgentRun = {
      id: "run_1", agentId: "a1", status: "succeeded", input: "search releases", output: "found two hits",
      tokensUsed: 42, startedAt: 1_700_000_000_000, endedAt: 1_700_000_002_000,
      steps: [
        { index: 0, kind: "assistant", text: "Looking that up.", tokens: 3 },
        { index: 1, kind: "tool", tool: "fs.search", args: { q: "releases" }, result: { hits: 2 } },
      ],
    };
    const out = html(<RunView {...runViewProps} run={run} agentName="Research Assistant" />);
    expect(out).toContain("Research Assistant");
    expect(out).toContain("Looking that up.");
    expect(out).toContain("fs.search");
    expect(out).toContain("found two hits");
    expect(out).toContain("42");
  });

  test("a running run offers cancel", () => {
    const run: AgentRun = {
      id: "run_2", agentId: "a1", status: "running", input: "long task", output: "", steps: [], tokensUsed: 0,
      startedAt: 1_700_000_000_000,
    };
    const out = html(<RunView {...runViewProps} run={run} streaming />);
    expect(out).toContain("Cancel run");
    expect(out).toContain("Live — new steps arrive");
  });

  test("a failed run shows why", () => {
    const run: AgentRun = {
      id: "run_3", agentId: "a1", status: "failed", input: "x", output: "", steps: [], tokensUsed: 0,
      startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000, error: "provider_error: 401 from upstream",
    };
    const out = html(<RunView {...runViewProps} run={run} />);
    expect(out).toContain("provider_error: 401 from upstream");
  });
});

const plugin = (over: Partial<PluginView> = {}): PluginView => ({
  id: "github", name: "GitHub", version: "1.0.0", description: "Issues and pull requests.",
  permissions: ["network", "secrets"], config: [{ name: "token", type: "string", required: true, secret: true, description: "personal access token" }],
  configValues: {}, missingRequired: ["token"], tools: ["github.issue"], installed: false, enabled: false, updatedAt: 1_700_000_000_000,
  ...over,
});

const module = (id: string, state: ModuleView["state"], over: Partial<ModuleView> = {}): ModuleView =>
  ({ id, state, requires: [], dependants: [], missing: [], ...over });

const pluginsProps = {
  plugins: [] as PluginView[],
  modules: [] as ModuleView[],
  loading: false,
  error: null as string | null,
  busyId: null as string | null,
  moduleError: null as string | null,
  moduleBusy: null as string | null,
  cardErrors: {},
  onToggle: () => undefined,
  onSave: () => undefined,
  onUninstall: () => undefined,
  onModuleToggle: () => undefined,
  onRetry: () => undefined,
};

describe("web views — plugins", () => {
  test("an empty registry says how to add one", () => {
    expect(html(<PluginsView {...pluginsProps} />)).toContain("No plugins installed");
  });

  test("a plugin with unmet config says what is missing instead of failing silently", () => {
    const out = html(<PluginsView {...pluginsProps} plugins={[plugin()]} />);
    expect(out).toContain("Needs configuration");
    expect(out).toContain("token");
    expect(out).toContain("network");
    expect(out).toContain("secrets");
  });

  test("modules are listed with their state and a toggle", () => {
    const out = html(
      <PluginsView
        {...pluginsProps}
        modules={[module("chat", "running", { dependants: ["agents"] }), module("plugins", "stopped")]}
      />,
    );
    expect(out).toContain("Capability modules");
    expect(out).toContain("chat");
    expect(out).toContain("running");
    expect(out).toContain("Stop");
    expect(out).toContain("Start");
  });

  test("an error keeps the last known list on screen", () => {
    const out = html(<PluginsView {...pluginsProps} plugins={[plugin()]} error="cannot reach the harness server" />);
    expect(out).toContain("cannot reach the harness server");
    expect(out).toContain("Showing the last known list");
  });
});

const settings: SettingsPayload = {
  settings: { provider: "mock", model: "" },
  providers: ["mock", "openai-compat"],
  defaultProvider: "mock",
  tools: ["fs.read", "fs.write"],
  workspace: "/tmp/harness/workspace",
  version: "0.1.0",
  modules: [module("chat", "running")],
};

const settingsProps = {
  data: null as SettingsPayload | null,
  values: { provider: "", model: "" },
  error: null as string | null,
  saved: false,
  saving: false,
  onChange: () => undefined,
  onSave: () => undefined,
  onSignOut: () => undefined,
};

describe("web views — settings", () => {
  test("shows progress while the payload loads", () => {
    expect(html(<SettingsView {...settingsProps} />)).toContain("Reading instance settings");
  });

  test("provider options come from the server, not a hard-coded list", () => {
    const out = html(<SettingsView {...settingsProps} data={settings} values={settings.settings} />);
    expect(out).toContain("openai-compat");
    expect(out).toContain("built-in default (mock)");
  });

  test("read-only facts name the workspace, version and tools", () => {
    const out = html(<SettingsView {...settingsProps} data={settings} values={settings.settings} />);
    expect(out).toContain("/tmp/harness/workspace");
    expect(out).toContain("0.1.0");
    expect(out).toContain("fs.read");
    expect(out).toContain("chat:running");
  });

  test("a saved change is confirmed in place", () => {
    expect(html(<SettingsView {...settingsProps} data={settings} values={settings.settings} saved />)).toContain("Saved.");
  });

  test("a rejected token is explained and signing out is offered", () => {
    const out = html(<SettingsView {...settingsProps} data={settings} values={settings.settings} error="Your access token was rejected." />);
    expect(out).toContain("rejected");
    expect(out).toContain("Forget token and sign out");
  });
});

describe("web views — home and 404", () => {
  test("home counts are real numbers, and dashes until known", () => {
    expect(html(<HomeView agents={2} conversations={1} plugins={2} />)).toContain("2");
    expect(html(<HomeView agents={null} conversations={null} plugins={null} />)).toContain("—");
  });

  test("the Files card reports a real count and copy that is true in either kernel", () => {
    const out = html(<HomeView agents={2} conversations={1} plugins={2} files={3} />);
    expect(out).toContain("files at the root");
    expect(out).not.toContain("A real directory on disk");
    expect(html(<HomeView agents={2} conversations={1} plugins={2} />)).toContain("\u2014");
  });

  test("an unknown path renders 404 with a way back", () => {
    const out = html(<NotFoundView path="/nope" />);
    expect(out).toContain("404");
    expect(out).toContain("/nope");
    expect(out).toContain("Back to the workspace");
  });
});

describe("router", () => {
  test("every declared pattern is routable and unknown paths are not", () => {
    for (const pattern of ROUTE_PATTERNS) {
      const concrete = pattern.replace(":id", "run_1");
      expect(matchRoute(ROUTE_PATTERNS, concrete)?.path).toBe(pattern);
    }
    expect(matchRoute(ROUTE_PATTERNS, "/nope")).toBeNull();
    expect(matchRoute(ROUTE_PATTERNS, "/runs/run_1/extra")).toBeNull();
  });

  test("dynamic params are decoded", () => {
    expect(matchRoute(ROUTE_PATTERNS, "/runs/run%2F1")?.params.id).toBe("run/1");
  });
});
