import type { Store } from "../store/types";
import type { WorkspaceLike } from "../fs/types";
import type { AgentService } from "../agents/service";
import { SETTING_PROVIDER } from "./routes-workspace";

export const SEED_KEY = "seed.version";
export const SEED_VERSION = "1";

export interface SeedDeps {
  store: Store;
  workspace: WorkspaceLike;
  agents: AgentService;
}

export interface SeedResult {
  seeded: boolean;
  agents: number;
  conversations: number;
  runs: number;
  files: number;
}

const README = `# Workspace

This directory is the file system the agents and the chat tool loop can read and write.

- \`notes/\` — working notes
- \`data/\` — small datasets you want an agent to reason over
- \`releases.csv\` — sample release log used by the release-note agent

Everything here is a plain file, and nothing sits in a database: the Files tab in the UI
is a view of this workspace. Where that workspace lives depends on the build — on a server
install it is a directory on disk; in the browser demo it is held in the tab and re-seeded
when the page loads, so a file saved there does not survive a refresh.
`;

const ONBOARDING = `# Onboarding
Shell commands run sandboxed here: an allowlist, a timeout and an output cap.

1. Open **Chat** and send a message. With the \`mock\` provider no API key is needed —
   it echoes your text and can call tools on request (\`/tool fs.list\`).
2. Add a provider key in \`Settings\` to talk to a real model.
3. Open **Agents** to run the seeded pair: *Research Assistant* reads the workspace,
   *Release Note Writer* turns \`data/releases.csv\` into notes.
4. Open **Plugins** to enable GitHub or the outbound webhook. Both are inert until
   you fill in their required config.
`;

const RELEASES = `version,date,summary,owner
0.1.0,2026-11-04,Module registry and dependency-ordered start,platform
0.2.0,2026-11-07,Sandboxed shell with command allowlist,platform
0.3.0,2026-11-11,Agent runner with step and token budgets,agents
0.4.0,2026-11-13,Plugin manifests and runtime enable/disable,integrations
`;

const RESEARCH_PROMPT = `You are Research Assistant, a careful analyst working inside a file workspace.

Read before you assert. Use fs.list and fs.search to locate evidence, then fs.read the
files you need. Cite the file path for every claim. If the workspace does not answer the
question, say so plainly instead of guessing.`;

const WRITER_PROMPT = `You are Release Note Writer. You turn a release log into notes a customer can read.

Use fs.read to load data/releases.csv, group entries by owner, and write a short markdown
summary with fs.write to notes/release-notes.md. Keep sentences short and skip internal
jargon. Never invent a version that is not in the file.`;

/** The three seed files, written to any workspace. Exported because a store can
 *  outlive a workspace: the browser demo keeps its store in localStorage while its
 *  workspace lives in the tab, so a reload finds the store already seeded and an
 *  empty workspace. Callers use this to put the files back without touching agents. */
export function writeSeedFiles(workspace: WorkspaceLike): string[] {
  const files: Array<[string, string]> = [
    ["README.md", README],
    ["notes/onboarding.md", ONBOARDING],
    ["data/releases.csv", RELEASES],
  ];
  for (const [path, content] of files) workspace.write(path, content);
  return files.map(([path]) => path);
}

export async function seedIfNeeded(deps: SeedDeps): Promise<SeedResult> {
  const done = await deps.store.getSetting(SEED_KEY);
  if (done) return { seeded: false, agents: 0, conversations: 0, runs: 0, files: 0 };

  writeSeedFiles(deps.workspace);

  const research = await deps.agents.createAgent({
    name: "Research Assistant",
    systemPrompt: RESEARCH_PROMPT,
    provider: await deps.store.getSetting(SETTING_PROVIDER) || "mock",
    tools: ["fs.list", "fs.read", "fs.search"],
    maxSteps: 6,
    maxTokens: 3000,
  });

  const writer = await deps.agents.createAgent({
    name: "Release Note Writer",
    systemPrompt: WRITER_PROMPT,
    provider: await deps.store.getSetting(SETTING_PROVIDER) || "mock",
    tools: ["fs.read", "fs.write"],
    maxSteps: 4,
    maxTokens: 2000,
  });

  const conv = await deps.store.createConversation("Workspace tour");
  await deps.store.addMessage({
    conversationId: conv.id,
    role: "user",
    content: "What is in this workspace?",
  });
  await deps.store.addMessage({
    conversationId: conv.id,
    role: "assistant",
    content:
      "Three things: a README, notes/onboarding.md, and data/releases.csv with four releases. " +
      "Ask me to run a tool and I will read them for you.",
  });
  await deps.store.addMessage({
    conversationId: conv.id,
    role: "user",
    content: "Summarise data/releases.csv for a customer.",
  });

  // Runs are produced by the real runner against the mock provider, so the seeded
  // view contains no hand-written steps: whatever the run viewer shows, it happened.
  const readRelease = await deps.agents.run(research.id, '/tool fs.read {"path": "data/releases.csv"}');
  const draftNotes = await deps.agents.run(writer.id, "Draft the November release summary.");

  await deps.store.setSetting(SEED_KEY, SEED_VERSION);
  return {
    seeded: true,
    agents: 2,
    conversations: 1,
    runs: [readRelease, draftNotes].filter((r) => r.steps.length > 0).length,
    files: 3,
  };
}
