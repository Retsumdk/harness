import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner, Loading, StatusBadge } from "../components";
import { type Agent, type AgentRun, type RunSummary, describeError } from "../api";
import { useApi } from "../api-context";
import { Link, navigate } from "../router";

export interface AgentEditor {
  id?: string;
  name: string;
  systemPrompt: string;
  model: string;
  tools: string[];
  maxSteps: string;
  maxTokens: string;
}

export const blankEditor = (): AgentEditor => ({
  name: "", systemPrompt: "", model: "", tools: [], maxSteps: "8", maxTokens: "2000",
});

export function editorFrom(agent: Agent): AgentEditor {
  return {
    id: agent.id, name: agent.name, systemPrompt: agent.systemPrompt, model: agent.model ?? "",
    tools: agent.tools, maxSteps: String(agent.maxSteps), maxTokens: String(agent.maxTokens),
  };
}

export function AgentCard({
  agent, runs, onRun, onEdit, onDelete, launching,
}: {
  agent: Agent;
  runs: RunSummary[];
  onRun: (agent: Agent, input: string) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
  launching: boolean;
}) {
  const [input, setInput] = useState("");
  return (
    <article className="card agent-card">
      <div className="card-head">
        <h3>{agent.name}</h3>
        <span className="badge badge-idle">{agent.provider}{agent.model ? ` · ${agent.model}` : ""}</span>
      </div>
      <p className="muted small clamp-2">{agent.systemPrompt || "No system prompt — the agent will answer plainly."}</p>
      <div className="chips">
        {agent.tools.length === 0 ? <span className="muted small">no tools</span> : agent.tools.map((t) => <span className="chip mono" key={t}>{t}</span>)}
      </div>
      <p className="muted small">budget: {agent.maxSteps} steps · {agent.maxTokens} tokens</p>

      <form
        className="run-form"
        onSubmit={(e) => { e.preventDefault(); if (input.trim()) onRun(agent, input.trim()); }}
      >
        <input
          className="input"
          placeholder="Task for this agent…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label={`Task for ${agent.name}`}
        />
        <button className="btn btn-primary" type="submit" disabled={!input.trim() || launching}>
          {launching ? "Starting…" : "Run"}
        </button>
      </form>

      <div className="card-foot">
        <button className="btn btn-quiet" onClick={() => onEdit(agent)}>Edit</button>
        <button className="btn btn-danger" onClick={() => onDelete(agent)}>Delete</button>
        <span className="grow" />
        {runs.length === 0 ? (
          <span className="muted small">no runs yet</span>
        ) : (
          <span className="row small">
            {runs.slice(0, 3).map((run) => (
              <Link key={run.id} className="run-link" to={`/runs/${run.id}`}>
                <StatusBadge status={run.status} /> <span className="mono">{run.id.slice(-4)}</span>
              </Link>
            ))}
          </span>
        )}
      </div>
    </article>
  );
}

export function AgentEditorCard({
  editor, tools, error, saving, onChange, onSave, onClose,
}: {
  editor: AgentEditor;
  tools: string[];
  error: string | null;
  saving: boolean;
  onChange: (patch: Partial<AgentEditor>) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const toggle = (tool: string) => {
    const has = editor.tools.includes(tool);
    onChange({ tools: has ? editor.tools.filter((t) => t !== tool) : [...editor.tools, tool] });
  };
  return (
    <form
      className="card editor-card"
      onSubmit={(e) => { e.preventDefault(); onSave(); }}
    >
      <div className="card-head">
        <h3>{editor.id ? "Edit agent" : "New agent"}</h3>
        <button type="button" className="btn btn-quiet btn-inline" onClick={onClose}>Close</button>
      </div>

      <label className="label" htmlFor="agent-name">Name</label>
      <input
        id="agent-name" className="input" value={editor.name} maxLength={64}
        onChange={(e) => onChange({ name: e.target.value })} placeholder="Changelog Writer"
      />

      <label className="label" htmlFor="agent-prompt">System prompt</label>
      <textarea
        id="agent-prompt" className="editor" value={editor.systemPrompt}
        onChange={(e) => onChange({ systemPrompt: e.target.value })}
        placeholder="What the agent is for, what it may read, how it should answer."
      />

      <div className="grid-2">
        <div>
          <label className="label" htmlFor="agent-steps">Max steps</label>
          <input id="agent-steps" className="input" value={editor.maxSteps} inputMode="numeric"
            onChange={(e) => onChange({ maxSteps: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="agent-tokens">Max tokens</label>
          <input id="agent-tokens" className="input" value={editor.maxTokens} inputMode="numeric"
            onChange={(e) => onChange({ maxTokens: e.target.value })} />
        </div>
      </div>

      <label className="label" htmlFor="agent-model">Model override (optional)</label>
      <input id="agent-model" className="input" value={editor.model} maxLength={120}
        onChange={(e) => onChange({ model: e.target.value })} placeholder="leave empty for the provider default" />

      <fieldset className="fieldset">
        <legend className="label">Tools</legend>
        {tools.length === 0 ? (
          <p className="muted small">No tools are registered right now. Start the tools module in Settings.</p>
        ) : (
          <div className="chips">
            {tools.map((tool) => (
              <label className="chip chip-toggle" key={tool}>
                <input type="checkbox" checked={editor.tools.includes(tool)} onChange={() => toggle(tool)} />
                <span className="mono">{tool}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={saving || !editor.name.trim()}>
          {saving ? "Saving…" : editor.id ? "Save changes" : "Create agent"}
        </button>
      </div>
    </form>
  );
}

export function AgentsView({
  agents, runsByAgent, tools, loading, error, editor, editorError, saving, launching, notice,
  onNew, onEdit, onChange, onSave, onClose, onDelete, onRun, reload,
}: {
  agents: Agent[];
  runsByAgent: Record<string, RunSummary[]>;
  tools: string[];
  loading: boolean;
  error: string | null;
  editor: AgentEditor | null;
  editorError: string | null;
  saving: boolean;
  launching: boolean;
  notice: string | null;
  onNew: () => void;
  onEdit: (agent: Agent) => void;
  onChange: (patch: Partial<AgentEditor>) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete: (agent: Agent) => void;
  onRun: (agent: Agent, input: string) => void;
  reload: () => void;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="muted">A definition, a tool allowlist and a budget. Each run is logged step by step.</p>
        </div>
        <div className="row">
          <button className="btn btn-quiet" onClick={reload} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
          <button className="btn btn-primary" onClick={onNew}>New agent</button>
        </div>
      </header>

      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}

      {editor ? (
        <AgentEditorCard
          editor={editor} tools={tools} error={editorError} saving={saving}
          onChange={onChange} onSave={onSave} onClose={onClose}
        />
      ) : null}

      {loading && agents.length === 0 ? <Loading label="Loading agents…" /> : null}

      {!loading && agents.length === 0 && !editor ? (
        <EmptyState
          title="No agents yet"
          body="An agent is a saved prompt plus the tools it may use. Create one, give it a budget, and run it on a task."
          action={<button className="btn btn-primary" onClick={onNew}>Create your first agent</button>}
        />
      ) : null}

      <div className="grid-cards">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id} agent={agent} runs={runsByAgent[agent.id] ?? []} launching={launching}
            onRun={onRun} onEdit={(a) => onEdit(a)} onDelete={(a) => onDelete(a)}
          />
        ))}
      </div>
    </div>
  );
}

export function AgentsPage({ focusId }: { focusId?: string } = {}) {
  const api = useApi();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runsByAgent, setRunsByAgent] = useState<Record<string, RunSummary[]>>({});
  const [tools, setTools] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<AgentEditor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, settings] = await Promise.all([api.listAgents(), api.settings()]);
      setAgents(list);
      setTools(settings.tools);
      const runs = await Promise.all(list.map(async (a) => [a.id, await api.listRuns(a.id)] as const));
      setRunsByAgent(Object.fromEntries(runs));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!editor) return;
    setSaving(true);
    setEditorError(null);
    const payload = {
      name: editor.name.trim(),
      systemPrompt: editor.systemPrompt,
      model: editor.model.trim() || undefined,
      tools: editor.tools,
      maxSteps: Number(editor.maxSteps),
      maxTokens: Number(editor.maxTokens),
    };
    try {
      if (editor.id) await api.updateAgent(editor.id, payload);
      else await api.createAgent(payload);
      setNotice(editor.id ? `Saved ${payload.name}` : `Created ${payload.name}`);
      setEditor(null);
      await load();
    } catch (e) {
      setEditorError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (agent: Agent) => {
    if (typeof window !== "undefined" && !window.confirm(`Delete agent “${agent.name}”?`)) return;
    setNotice(null);
    try {
      await api.deleteAgent(agent.id);
      setNotice(`Deleted ${agent.name}`);
      if (editor?.id === agent.id) setEditor(null);
      await load();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const run = async (agent: Agent, input: string) => {
    setLaunching(true);
    setError(null);
    try {
      const runId = await api.startRun(agent.id, input);
      navigate(`/runs/${runId}`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <AgentsView
      agents={agents} runsByAgent={runsByAgent} tools={tools} loading={loading} error={error}
      editor={editor} editorError={editorError} saving={saving} launching={launching} notice={notice}
      onNew={() => { setEditor(blankEditor()); setEditorError(null); }}
      onEdit={(a) => { setEditor(editorFrom(a)); setEditorError(null); }}
      onChange={(patch) => setEditor((prev) => (prev ? { ...prev, ...patch } : prev))}
      onSave={() => void save()}
      onClose={() => { setEditor(null); setEditorError(null); }}
      onDelete={(a) => void remove(a)}
      onRun={(a, input) => void run(a, input)}
      reload={() => void load()}
    />
  );
}

export default AgentsPage;
