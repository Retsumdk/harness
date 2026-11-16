import { useCallback, useEffect, useState } from "react";
import { type ModuleView, type PluginView, describeError, type HarnessApi } from "../api";
import { useApi } from "../api-context";
import { Badge, Button, EmptyState, ErrorBanner, Field, Loading } from "../components";

export function PluginCard({
  plugin, busy, onToggle, onSave, onUninstall, error,
}: {
  plugin: PluginView;
  busy: boolean;
  onToggle: () => void;
  onSave: (config: Record<string, string | number | boolean>) => void;
  onUninstall: () => void;
  error: string | null;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const update = (name: string, value: string) => setValues((prev) => ({ ...prev, [name]: value }));
  const blocked = plugin.missingRequired.length > 0;

  const save = () => {
    const payload: Record<string, string | number | boolean> = {};
    for (const field of plugin.config) {
      const raw = values[field.name];
      if (raw === undefined || raw === "") continue;
      payload[field.name] = field.type === "number" ? Number(raw) : field.type === "boolean" ? raw === "true" : raw;
    }
    onSave(payload);
  };

  return (
    <article className="card plugin-card">
      <div className="plugin-head">
        <div>
          <h2>{plugin.name} <span className="muted mono small">v{plugin.version}</span></h2>
          <p className="muted">{plugin.description}</p>
        </div>
        <div className="row">
          {plugin.enabled ? <Badge tone="good">enabled</Badge> : <Badge>disabled</Badge>}
        </div>
      </div>

      <div className="row wrap gap-sm">
        <span className="muted small">permissions:</span>
        {plugin.permissions.length === 0 ? <span className="muted small">none</span> : null}
        {plugin.permissions.map((p) => <Badge key={p} tone={p === "secrets" ? "warn" : "idle"}>{p}</Badge>)}
        <span className="muted small">tools:</span>
        {plugin.tools.length === 0 ? <span className="muted small">none</span> : null}
        {plugin.tools.map((t) => <code key={t} className="chip mono">{t}</code>)}
      </div>

      {blocked ? (
        <p className="alert alert-warn" role="status">
          Needs configuration before it can be enabled: {plugin.missingRequired.join(", ")}
        </p>
      ) : null}

      {plugin.config.length > 0 ? (
        <div className="grid-2">
          {plugin.config.map((field) => (
            <Field key={field.name} label={`${field.name}${field.required ? "" : " (optional)"}`} hint={field.description}>
              {field.type === "boolean" ? (
                <select className="input" value={values[field.name] ?? ""} onChange={(e) => update(field.name, e.target.value)}>
                  <option value="">unchanged ({String(plugin.configValues[field.name] ?? "unset")})</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  className="input"
                  type={field.secret ? "password" : field.type === "number" ? "number" : "text"}
                  placeholder={plugin.configValues[field.name] !== undefined ? "stored — type to replace" : field.secret ? "secret value" : "value"}
                  value={values[field.name] ?? ""}
                  onChange={(e) => update(field.name, e.target.value)}
                />
              )}
            </Field>
          ))}
        </div>
      ) : null}

      {error ? <p className="alert alert-error" role="alert">{error}</p> : null}

      <div className="row">
        <Button variant="primary" onClick={onToggle} busy={busy} disabled={blocked && !plugin.enabled}>
          {plugin.enabled ? "Disable" : "Enable"}
        </Button>
        {plugin.config.length > 0 ? <Button onClick={save} busy={busy}>Save config</Button> : null}
        {plugin.enabled ? null : (
          <Button variant="danger" onClick={onUninstall} busy={busy} title="Removes the stored config">Uninstall</Button>
        )}
      </div>
    </article>
  );
}

export function ModulesPanel({
  modules, busy, error, onToggle,
}: {
  modules: ModuleView[];
  busy: string | null;
  error: string | null;
  onToggle: (id: string, running: boolean) => void;
}) {
  return (
    <section className="card panel">
      <div className="panel-head">
        <h2>Capability modules</h2>
        <p className="muted small">A stopped module closes its API routes. Modules with dependants cannot be stopped.</p>
      </div>
      {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
      {modules.length === 0 ? (
        <EmptyState title="No modules registered" body="This build of the harness registered no capability modules." />
      ) : (
        <ul className="module-list">
          {modules.map((m) => (
            <li key={m.id} className="module-row">
              <div>
                <strong className="mono">{m.id}</strong>
                {m.version ? <span className="muted small"> v{m.version}</span> : null}
                <p className="muted small">
                  {m.requires.length ? `requires ${m.requires.join(", ")}` : "no dependencies"}
                  {m.dependants.length ? ` · used by ${m.dependants.join(", ")}` : ""}
                </p>
              </div>
              <div className="row">
                {m.state === "running" ? <Badge tone="good">running</Badge> : <Badge tone="warn">{m.state}</Badge>}
                <Button
                  variant={m.state === "running" ? "danger" : "primary"}
                  busy={busy === m.id}
                  disabled={m.state === "running" && m.dependants.length > 0}
                  title={m.state === "running" && m.dependants.length > 0 ? `still required by ${m.dependants.join(", ")}` : undefined}
                  onClick={() => onToggle(m.id, m.state === "running")}
                >
                  {m.state === "running" ? "Stop" : "Start"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PluginsView({
  plugins, modules, loading, error, busyId, moduleError, moduleBusy, cardErrors, onToggle, onSave, onUninstall, onModuleToggle, onRetry,
}: {
  plugins: PluginView[];
  modules: ModuleView[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
  moduleError: string | null;
  moduleBusy: string | null;
  cardErrors: Record<string, string>;
  onToggle: (id: string, enabled: boolean) => void;
  onSave: (id: string, config: Record<string, string | number | boolean>) => void;
  onUninstall: (id: string) => void;
  onModuleToggle: (id: string, running: boolean) => void;
  onRetry: () => void;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Plugins</h1>
          <p className="muted">Integrations are manifests: they declare permissions, config and tool names, and the runtime registers their tools only while they are enabled.</p>
        </div>
      </header>

      {error ? <ErrorBanner message={error} onRetry={onRetry} /> : null}
      {error && plugins.length > 0 ? <p className="muted small">Showing the last known list.</p> : null}

      {loading && plugins.length === 0 ? <Loading label="Loading plugins…" /> : null}

      {!loading && !error && plugins.length === 0 ? (
        <EmptyState
          title="No plugins installed"
          body="This build ships no plugin implementations. Install one by POSTing a manifest to /api/plugins."
        />
      ) : null}

      <div className="stack">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            busy={busyId === plugin.id}
            error={cardErrors[plugin.id] ?? null}
            onToggle={() => onToggle(plugin.id, plugin.enabled)}
            onSave={(config) => onSave(plugin.id, config)}
            onUninstall={() => onUninstall(plugin.id)}
          />
        ))}
      </div>

      <ModulesPanel modules={modules} busy={moduleBusy} error={moduleError} onToggle={onModuleToggle} />
    </div>
  );
}

export default function PluginsPage() {
  const api: HarnessApi = useApi();
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [modules, setModules] = useState<ModuleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [moduleBusy, setModuleBusy] = useState<string | null>(null);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, m] = await Promise.all([api.listPlugins(), api.listModules()]);
      setPlugins(p);
      setModules(m);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load, nonce]);

  const patch = (id: string, next: PluginView) => setPlugins((prev) => prev.map((p) => (p.id === id ? next : p)));

  const toggle = async (id: string, enabled: boolean) => {
    setBusyId(id);
    setCardErrors((prev) => ({ ...prev, [id]: "" }));
    try {
      patch(id, await (enabled ? api.disablePlugin(id) : api.enablePlugin(id)));
    } catch (e) {
      setCardErrors((prev) => ({ ...prev, [id]: describeError(e) }));
    } finally {
      setBusyId(null);
    }
  };

  const save = async (id: string, config: Record<string, string | number | boolean>) => {
    setBusyId(id);
    setCardErrors((prev) => ({ ...prev, [id]: "" }));
    try {
      patch(id, await api.configurePlugin(id, config));
    } catch (e) {
      setCardErrors((prev) => ({ ...prev, [id]: describeError(e) }));
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = async (id: string) => {
    setBusyId(id);
    try {
      await api.uninstallPlugin(id);
      setPlugins((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setCardErrors((prev) => ({ ...prev, [id]: describeError(e) }));
    } finally {
      setBusyId(null);
    }
  };

  const moduleToggle = async (id: string, running: boolean) => {
    setModuleBusy(id);
    setModuleError(null);
    try {
      const next = await (running ? api.disableModule(id) : api.enableModule(id));
      setModules((prev) => prev.map((m) => (m.id === id ? next : m)));
      setModules(await api.listModules());
    } catch (e) {
      setModuleError(describeError(e));
    } finally {
      setModuleBusy(null);
    }
  };

  return (
    <PluginsView
      plugins={plugins} modules={modules} loading={loading} error={error} busyId={busyId}
      moduleError={moduleError} moduleBusy={moduleBusy} cardErrors={cardErrors}
      onToggle={(id, enabled) => void toggle(id, enabled)}
      onSave={(id, config) => void save(id, config)}
      onUninstall={(id) => void uninstall(id)}
      onModuleToggle={(id, running) => void moduleToggle(id, running)}
      onRetry={() => setNonce((n) => n + 1)}
    />
  );
}
