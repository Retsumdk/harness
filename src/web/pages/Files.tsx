import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner, Loading, formatBytes } from "../components";
import { describeError } from "../api";
import { useApi } from "../api-context";
import { Link, useSearchParams } from "../router";

export interface DirEntry { name: string; kind: string; path: string; size?: number }
export interface DirListing { type: "dir"; path: string; entries: DirEntry[] }
export interface FileListing { type: "file"; path: string; content: string; size: number }
export type Listing = DirListing | FileListing;

export function ParentLink({ path }: { path: string }) {
  if (!path || path === ".") return null;
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  return (
    <Link className="crumb" to={`/files?path=${encodeURIComponent(parent)}`}>
      ← {parent === "." ? "workspace root" : parent}
    </Link>
  );
}

export function FilesView({
  path, listing, loading, error, searchQuery, searchResults, searchLoading,
  draft, saving, notice, onOpenDir, onOpenFile, onSave, onDraft, onSearch, onClearSearch, onDelete, onCreate, creating, reload,
}: {
  path: string;
  listing: Listing | null;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  searchResults: { path: string; line: number; text: string }[] | null;
  searchLoading: boolean;
  draft: string;
  saving: boolean;
  notice: string | null;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSave: () => void;
  onDraft: (value: string) => void;
  onSearch: (q: string) => void;
  onClearSearch: () => void;
  onDelete: (path: string) => void;
  onCreate: (path: string) => void;
  creating: boolean;
  reload: () => void;
}) {
  const [query, setQuery] = useState(searchQuery);
  const [newPath, setNewPath] = useState("");
  const [newOpen, setNewOpen] = useState(false);

  return (
    <div className="page files">
      <header className="page-head">
        <div>
          <h1>Files</h1>
          <p className="muted">Plain files: browse, edit and search the same workspace agents work in.</p>
        </div>
        <div className="row">
          <button className="btn btn-quiet" onClick={reload} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn btn-primary" onClick={() => setNewOpen((v) => !v)}>
            {newOpen ? "Cancel" : "New file"}
          </button>
        </div>
      </header>

      <div className="row search-row">
        <input
          className="input"
          placeholder="Search file contents (e.g. release)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSearch(query); }}
        />
        <button className="btn" onClick={() => onSearch(query)} disabled={!query.trim() || searchLoading}>
          {searchLoading ? "Searching…" : "Search"}
        </button>
        {searchResults ? <button className="btn btn-quiet" onClick={onClearSearch}>Clear</button> : null}
      </div>

      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}

      {newOpen ? (
        <form
          className="card inline-form"
          onSubmit={(e) => { e.preventDefault(); onCreate(newPath); setNewPath(""); }}
        >
          <label className="label" htmlFor="new-file">New file path</label>
          <div className="row">
            <input
              id="new-file"
              className="input"
              placeholder="notes/today.md"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={!newPath.trim() || creating}>
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
          <p className="muted small">Saved under the current folder: {path === "." ? "workspace root" : path}</p>
        </form>
      ) : null}

      <div className="split">
        <section className="card panel" aria-label="Directory listing">
          <div className="panel-head">
            <ParentLink path={path} />
            <span className="path mono">{path === "." ? "/" : `/${path}`}</span>
          </div>

          {loading && !listing ? <Loading label="Reading workspace…" /> : null}

          {searchResults && !searchLoading ? (
            searchResults.length === 0 ? (
              <EmptyState
                title="No matches"
                body={`Nothing in the workspace contains “${searchQuery}”. Try a shorter term.`}
                action={<button className="btn btn-quiet" onClick={onClearSearch}>Back to files</button>}
              />
            ) : (
              <ul className="list" aria-label="Search results">
                {searchResults.map((r) => (
                  <li key={`${r.path}:${r.line}`}>
                    <button className="row-link" onClick={() => onOpenFile(r.path)}>
                      <span className="mono small">{r.path}:{r.line}</span>
                      <span className="muted small ellipsis">{r.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : listing?.type === "dir" ? (
            listing.entries.length === 0 ? (
              <EmptyState
                title="This folder is empty"
                body="Nothing here yet. Create a file with “New file”, or ask an agent to write one for you."
              />
            ) : (
              <ul className="list" aria-label="Files">
                {listing.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      className="row-link"
                      onClick={() => (entry.kind === "dir" ? onOpenDir(entry.path) : onOpenFile(entry.path))}
                    >
                      <span className={entry.kind === "dir" ? "entry dir" : "entry"}>
                        {entry.kind === "dir" ? "▸ " : "· "}
                        {entry.name}
                      </span>
                      <span className="muted small">{entry.kind === "dir" ? "folder" : formatBytes(entry.size)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>

        <section className="card panel" aria-label="File preview">
          {listing?.type === "file" ? (
            <>
              <div className="panel-head">
                <span className="path mono">{listing.path}</span>
                <span className="muted small">{formatBytes(listing.size)}</span>
              </div>
              <textarea
                className="editor mono"
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                spellCheck={false}
                aria-label={`Contents of ${listing.path}`}
              />
              <div className="row">
                <button className="btn btn-primary" onClick={onSave} disabled={saving || draft === listing.content}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button className="btn btn-quiet" onClick={() => onDraft(listing.content)} disabled={draft === listing.content}>
                  Revert
                </button>
                <button className="btn btn-danger" onClick={() => onDelete(listing.path)}>Delete</button>
              </div>
              {saving ? <p className="muted small">Writing to disk…</p> : null}
            </>
          ) : (
            <EmptyState
              title="Pick a file to read it"
              body="Click any name in the list. Files can be edited and saved right here, or handed to an agent."
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** The folder a Files URL points at. A breadcrumb link, a reload and a deep link
 *  carry `?path=`; without it the page starts at the workspace root. */
export function pathFromSearch(params: { get: (k: string) => string | null }): string {
  const raw = params.get("path");
  return raw && raw.trim() !== "" ? raw : ".";
}

export function FilesPage() {
  const api = useApi();
  const [path, setPath] = useState(".");
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.files(target);
      setListing(next);
      setPath(next.path);
      if (next.type === "file") setDraft(next.content);
    } catch (e) {
      setError(describeError(e));
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  const requested = pathFromSearch(useSearchParams());
  // The folder is in the URL (`/files?path=notes`), so the breadcrumb link, a reload
  // and a deep link all land where they say they will instead of falling back to the root.
  useEffect(() => { void load(requested); }, [load, requested]);

  const openFile = (target: string) => { setSearchResults(null); void load(target); };
  const openDir = (target: string) => { setSearchResults(null); void load(target); };

  const save = async () => {
    if (listing?.type !== "file") return;
    setSaving(true);
    setNotice(null);
    try {
      await api.writeFile(listing.path, draft);
      await load(listing.path);
      setNotice(`Saved ${listing.path}`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (target: string) => {
    if (typeof window !== "undefined" && !window.confirm(`Delete ${target}? This cannot be undone.`)) return;
    setNotice(null);
    try {
      await api.deleteFile(target);
      setNotice(`Deleted ${target}`);
      await load(".");
    } catch (e) {
      setError(describeError(e));
    }
  };

  const create = async (raw: string) => {
    const target = raw.trim();
    if (!target) return;
    setCreating(true);
    setNotice(null);
    const dir = path === "." || path === "" || path === "/" ? "" : `${path.replace(/\/+$/, "")}/`;
    const full = `${dir}${target}`;
    try {
      await api.writeFile(full, "");
      setNotice(`Created ${full}`);
      await load(full);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCreating(false);
    }
  };

  const search = async (q: string) => {
    const term = q.trim();
    if (!term) return;
    setSearchLoading(true);
    setError(null);
    try {
      setSearchQuery(term);
      setSearchResults(await api.searchFiles(term));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSearchLoading(false);
    }
  };

  return (
    <FilesView
      path={path}
      listing={listing}
      loading={loading}
      error={error}
      draft={draft}
      saving={saving}
      notice={notice}
      searchQuery={searchQuery}
      searchResults={searchResults}
      searchLoading={searchLoading}
      creating={creating}
      reload={() => void load(path)}
      onOpenDir={openDir}
      onOpenFile={openFile}
      onSave={() => void save()}
      onDraft={setDraft}
      onSearch={(q) => void search(q)}
      onClearSearch={() => { setSearchResults(null); setSearchQuery(""); }}
      onDelete={(target) => void remove(target)}
      onCreate={(target) => void create(target)}
    />
  );
}

export default FilesPage;
