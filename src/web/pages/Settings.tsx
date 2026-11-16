import { useCallback, useEffect, useState } from "react";
import { type SettingsPayload } from "../api";

type SettingsValues = { provider: string; model: string };
import { useApi } from "../api-context";
import { useAuth } from "../auth";
import { Button, ErrorBanner, Field, Loading, describeError } from "../components";

export function SettingsView({
  data, values, error, saved, saving, onChange, onSave, onSignOut,
}: {
  data: SettingsPayload | null;
  values: SettingsValues;
  error: string | null;
  saved: boolean;
  saving: boolean;
  onChange: (patch: Partial<SettingsValues>) => void;
  onSave: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Defaults for new chat messages and agents, plus what this instance actually has running.</p>
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      <form
        className="card panel"
        onSubmit={(e) => { e.preventDefault(); onSave(); }}
      >
        <div className="panel-head">
          <h2>Model defaults</h2>
          <p className="muted small">A message that names no provider uses this one. The model is passed through to the provider verbatim.</p>
        </div>

        <div className="grid-2">
          <Field label="Default provider" hint={data ? `available: ${data.providers.join(", ") || "none"}` : undefined}>
            <select
              className="input"
              value={values.provider}
              disabled={!data}
              onChange={(e) => onChange({ provider: e.target.value })}
            >
              <option value="">{data?.defaultProvider ? `built-in default (${data.defaultProvider})` : "unset"}</option>
              {(data?.providers ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Default model" hint="Leave empty to let the provider choose its own default.">
            <input
              className="input"
              value={values.model}
              placeholder="e.g. gpt-4o-mini"
              onChange={(e) => onChange({ model: e.target.value })}
            />
          </Field>
        </div>

        <div className="row">
          <Button type="submit" variant="primary" busy={saving} disabled={!data}>Save changes</Button>
          {saved ? <span className="ok small" role="status">Saved.</span> : null}
        </div>
      </form>

      <section className="card panel">
        <div className="panel-head">
          <h2>This instance</h2>
          <p className="muted small">Read-only facts about the process serving this page.</p>
        </div>
        {data ? (
          <dl className="facts">
            <dt>Version</dt><dd className="mono">{data.version}</dd>
            <dt>Workspace</dt><dd className="mono">{data.workspace}</dd>
            <dt>Providers</dt><dd className="mono">{data.providers.join(", ") || "none registered"}</dd>
            <dt>Built-in tools</dt><dd>{data.tools.length ? data.tools.map((t) => <code key={t} className="chip mono">{t}</code>) : <span className="muted">none</span>}</dd>
            <dt>Modules</dt><dd>{data.modules.length ? data.modules.map((m) => <code key={m.id} className="chip mono">{m.id}:{m.state}</code>) : <span className="muted">none</span>}</dd>
          </dl>
        ) : (
          <Loading label="Reading instance settings…" />
        )}
      </section>

      <section className="card panel">
        <div className="panel-head">
          <h2>Access</h2>
          <p className="muted small">This UI authenticates with the same bearer token the HTTP API uses. The token is held in this browser only.</p>
        </div>
        <Button variant="danger" onClick={onSignOut}>Forget token and sign out</Button>
      </section>
    </div>
  );
}

export default function SettingsPage() {
  const api = useApi();
  const { signOut } = useAuth();
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [values, setValues] = useState<SettingsValues>({ provider: "", model: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [payload, modules] = await Promise.all([api.settings(), api.listModules()]);
      setData({ ...payload, modules });
      setValues(payload.settings);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.saveSettings(values);
      setValues(next.settings);
      setSaved(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsView
      data={data}
      values={values}
      error={error}
      saved={saved}
      saving={saving}
      onChange={(patch) => { setSaved(false); setValues((prev) => ({ ...prev, ...patch })); }}
      onSave={() => void save()}
      onSignOut={signOut}
    />
  );
}
