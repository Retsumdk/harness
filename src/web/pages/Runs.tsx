import { useCallback, useEffect, useState } from "react";
import { Link } from "../router";
import { type Agent, type AgentRun, describeError, type RunStep } from "../api";
import { useApi } from "../api-context";
import { useRunStream } from "../use-stream";
import { EmptyState, ErrorBanner, Loading, StatusBadge } from "../components";

const time = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString() : "—");
const duration = (run: AgentRun) =>
  run.endedAt ? `${Math.max(0, Math.round((run.endedAt - run.startedAt) / 100) / 10)}s` : "in progress";

export function StepRow({ step }: { step: RunStep }) {
  if (step.kind === "assistant") {
    return (
      <li className="step">
        <div className="step-head">
          <span className="badge badge-assistant">assistant</span>
          <span className="muted small">step {step.index + 1} · {step.tokens} tokens</span>
        </div>
        <p className="step-text">{step.text || <span className="muted">(no text in this step)</span>}</p>
      </li>
    );
  }
  return (
    <li className={step.error ? "step step-failed" : "step"}>
      <div className="step-head">
        <span className="badge badge-tool">tool</span>
        <span className="mono small">{step.tool}</span>
        {step.error ? <span className="badge badge-bad">error</span> : null}
      </div>
      <pre className="code-block">{JSON.stringify(step.args, null, 2)}</pre>
      {step.error ? (
        <p className="step-error">{step.error}</p>
      ) : (
        <pre className="code-block muted">{JSON.stringify(step.result, null, 2)}</pre>
      )}
    </li>
  );
}

export function RunView({
  run, agentName, streaming, error, busy, onCancel, onRetry,
}: {
  run: AgentRun | null;
  agentName: string | null;
  streaming: boolean;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (!run) {
    return (
      <div className="page">
        {error ? <ErrorBanner message={error} onRetry={onRetry} /> : <Loading label="Loading run…" />}
      </div>
    );
  }
  const running = run.status === "running";
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="muted small"><Link className="crumb" to="/agents">← Agents</Link></p>
          <h1>Run <span className="mono">{run.id}</span></h1>
          <p className="muted">
            {agentName ?? run.agentId} · started {time(run.startedAt)} · {duration(run)} · {run.tokensUsed} tokens
          </p>
        </div>
        <div className="row">
          <StatusBadge status={run.status} />
          {running ? (
            <button className="btn btn-danger" onClick={onCancel} disabled={busy}>
              {busy ? "Cancelling…" : "Cancel run"}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <ErrorBanner message={error} onRetry={onRetry} /> : null}

      {run.error ? <p className="alert alert-error" role="alert">{run.error}</p> : null}
      {running && streaming ? <p className="muted small">Live — new steps arrive as the agent works.</p> : null}

      <section className="card panel" aria-label="Run steps">
        <div className="panel-head"><h2>Steps</h2></div>
        {run.steps.length === 0 ? (
          <EmptyState
            title={running ? "Waiting for the first step" : "This run produced no steps"}
            body={running
              ? "The agent is planning. Steps appear here the moment the provider returns one."
              : "The provider returned nothing. Check the agent's provider and model in Settings, then run it again."}
          />
        ) : (
          <ol className="steps">
            {run.steps.map((step) => <StepRow key={`${step.index}-${step.kind}`} step={step} />)}
          </ol>
        )}
      </section>

      <section className="card panel" aria-label="Run output">
        <div className="panel-head"><h2>Output</h2></div>
        {run.output ? <pre className="code-block">{run.output}</pre> : (
          <p className="muted">{running ? "No output yet." : "No output was produced."}</p>
        )}
      </section>
    </div>
  );
}

export function RunPage({ runId }: { runId?: string } = {}) {
  const api = useApi();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async () => {
    if (!runId) return;
    setError(null);
    try {
      const current = await api.getRun(runId);
      setRun(current);
      if (!agentName) {
        const agents = await api.listAgents().catch(() => [] as Agent[]);
        setAgentName(agents.find((a) => a.id === current.agentId)?.name ?? null);
      }
    } catch (e) {
      setError(describeError(e));
    }
  }, [api, runId, agentName]);

  useEffect(() => { void load(); }, [load, nonce]);

  const { connected } = useRunStream(api, run?.status === "running" ? runId ?? null : null, (event, data) => {
    if (event === "step") {
      const step = data as RunStep;
      setRun((prev) => (prev ? { ...prev, steps: [...prev.steps.filter((s) => s.index !== step.index), step].sort((a, b) => a.index - b.index) } : prev));
    } else if (event === "done") {
      setNonce((n) => n + 1);
    } else if (event === "error") {
      setError((data as { message?: string })?.message ?? "The live feed stopped. Refresh to catch up.");
      setNonce((n) => n + 1);
    }
  });

  const cancel = async () => {
    if (!run) return;
    setBusy(true);
    try {
      await api.cancelRun(run.id);
      setNonce((n) => n + 1);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RunView
      run={run} agentName={agentName} streaming={connected} error={error} busy={busy}
      onCancel={() => void cancel()} onRetry={() => setNonce((n) => n + 1)}
    />
  );
}

export default RunPage;
