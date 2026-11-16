import { useCallback, useEffect, useState } from "react";
import { describeError, type HarnessApi } from "./api";
import { ApiProvider, useApi } from "./api-context";
import { AuthProvider, useAuth } from "./auth";
import { Link, RouterProvider, useRouter } from "./router";
import { LoginScreen } from "./Login";
import ChatPage from "./pages/Chat";
import FilesPage from "./pages/Files";
import AgentsPage from "./pages/Agents";
import PluginsPage from "./pages/Plugins";
import SettingsPage from "./pages/Settings";
import { RunPage } from "./pages/Runs";
import { HomeView } from "./pages/Home";
import { NotFoundView } from "./pages/NotFound";

export const NAV = [
  { to: "/", label: "Workspace" },
  { to: "/chat", label: "Chat" },
  { to: "/files", label: "Files" },
  { to: "/agents", label: "Agents" },
  { to: "/plugins", label: "Plugins" },
  { to: "/settings", label: "Settings" },
];

export function CurrentPage({ path, demo }: { path: string; demo?: boolean }) {
  if (path === "/" || path === "") return <HomePage demo={demo} />;
  if (path === "/chat") return <ChatPage />;
  if (path === "/files") return <FilesPage />;
  if (path === "/agents") return <AgentsPage />;
  if (path === "/plugins") return <PluginsPage />;
  if (path === "/settings") return <SettingsPage />;
  const run = /^\/runs\/([^/]+)$/.exec(path);
  if (run) return <RunPage runId={decodeURIComponent(run[1])} />;
  return <NotFoundView path={path} />;
}

function HomePage({ demo }: { demo?: boolean } = {}) {
  const api = useApi();
  const [counts, setCounts] = useState<{ agents: number | null; conversations: number | null; plugins: number | null; files: number | null }>({
    agents: null, conversations: null, plugins: null, files: null,
  });
  useEffect(() => {
    let alive = true;
    void Promise.all([api.listAgents(), api.listConversations(), api.listPlugins()])
      .then(([agents, conversations, plugins]) => {
        if (alive) setCounts((prev) => ({ ...prev, agents: agents.length, conversations: conversations.length, plugins: plugins.length }));
      })
      .catch(() => undefined);
    // A real count, whichever kernel answers: on disk in the server build, in
    // memory in the demo. The card used to print a hardcoded 1.
    void api.files("/")
      .then((res) => {
        if (!alive) return;
        const n = res.type === "dir" ? res.entries.length : 1;
        setCounts((prev) => ({ ...prev, files: n }));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [api]);
  return <HomeView agents={counts.agents} conversations={counts.conversations} plugins={counts.plugins} files={counts.files} heading={demo ? "HARNESS workspace" : undefined} />;
}

function Shell({ demo }: { demo?: boolean } = {}) {
  const { token, api, signIn } = useAuth();
  const { path } = useRouter();
  const [authError, setAuthError] = useState<string | null>(null);

  const submitToken = useCallback(async (next: string) => {
    setAuthError(null);
    const previous = api.getToken();
    api.setToken(next);
    try {
      // Probe before accepting: a wrong token produces the server's own message, not a guess.
      await api.settings();
      signIn(next);
    } catch (e) {
      api.setToken(previous);
      setAuthError(describeError(e));
    }
  }, [api, signIn]);

  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const message = describeError(e.reason);
      if (/token/i.test(message)) setAuthError(message);
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);

  if (!token) return <LoginScreen onSubmit={(next) => void submitToken(next)} error={authError} />;

  return (
    <ApiProvider api={api}>
      <div className="shell">
        <aside className="sidebar">
          <Link to="/" className="brand">
            <span className="brand-glyph">H</span>
            <span className="brand-name">HARNESS</span>
          </Link>
          <nav className="nav" aria-label="Main">
            {NAV.map((item) => (
              <Link key={item.to} to={item.to} className={`nav-link${path === item.to ? " active" : ""}`}>
                {item.label}
              </Link>
            ))}
          </nav>
          <p className="sidebar-foot muted small">One process. Models, files, tools, agents.</p>
        </aside>
        <main className="main">
          <CurrentPage path={path} demo={demo} />
        </main>
      </div>
    </ApiProvider>
  );
}

export default function App({ api, initialToken, demo }: {
  /** Injected by the in-browser demo; the server build lets AuthProvider build one. */
  api?: HarnessApi;
  initialToken?: string | null;
  demo?: boolean;
} = {}) {
  return (
    <RouterProvider>
      <AuthProvider api={api} initialToken={initialToken}>
        <Shell demo={demo} />
      </AuthProvider>
    </RouterProvider>
  );
}
