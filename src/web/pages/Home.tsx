import { Link } from "../router";
import { Badge } from "../components";

export function HomeView({ agents, conversations, plugins, files = null, heading = "Workspace" }: { agents: number | null; conversations: number | null; plugins: number | null; files?: number | null; heading?: string }) {
  const stat = (n: number | null) => (n === null ? "—" : String(n));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{heading}</h1>
          <p className="muted">Everything below is served by this one process: models, files, tools and agent runs.</p>
        </div>
        <Badge tone="ok">running</Badge>
      </header>

      <div className="grid-3">
        <section className="card panel">
          <h2>Chat</h2>
          <p className="muted">Stream a reply from any configured provider. Tools are called inline, so answers can read your files.</p>
          <p className="stat">{stat(conversations)}<span className="stat-label">conversations</span></p>
          <Link to="/chat" className="link-arrow">Open chat →</Link>
        </section>
        <section className="card panel">
          <h2>Files</h2>
          <p className="muted">One workspace. The browser, the tools and the agents all read and write the same files.</p>
          <p className="stat">{stat(files)}<span className="stat-label">files at the root</span></p>
          <Link to="/files" className="link-arrow">Browse files →</Link>
        </section>
        <section className="card panel">
          <h2>Agents</h2>
          <p className="muted">Persisted definitions with a tool allowlist and step and token budgets. Each run is replayable step by step.</p>
          <p className="stat">{stat(agents)}<span className="stat-label">agents</span></p>
          <Link to="/agents" className="link-arrow">Run an agent →</Link>
        </section>
        <section className="card panel">
          <h2>Plugins</h2>
          <p className="muted">Declarative manifests that add tools at runtime. Secrets are write-only and masked on every read.</p>
          <p className="stat">{stat(plugins)}<span className="stat-label">plugins</span></p>
          <Link to="/plugins" className="link-arrow">Manage plugins →</Link>
        </section>
        <section className="card panel">
          <h2>Settings</h2>
          <p className="muted">Choose the default provider and model, and see which capability modules are running.</p>
          <Link to="/settings" className="link-arrow">Open settings →</Link>
        </section>
        <section className="card panel">
          <h2>HTTP API</h2>
          <p className="muted">Everything the UI does is a documented API call with the same bearer token. Script it from anywhere.</p>
          <pre className="snippet">curl -H "authorization: Bearer $HARNESS_TOKEN" \{"\n"}  localhost:8787/api/agents</pre>
        </section>
      </div>
    </div>
  );
}
