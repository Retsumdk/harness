import { Link } from "../router";

export function NotFoundView({ path }: { path?: string }) {
  return (
    <div className="page not-found">
      <p className="muted mono small">404</p>
      <h1>That page does not exist</h1>
      <p className="muted">
        {path ? <><code className="mono">{path}</code> is not a route in this workspace.</> : "This address is not a route in this workspace."}
      </p>
      <div className="row">
        <Link to="/" className="btn btn-primary">Back to the workspace</Link>
        <Link to="/chat" className="btn btn-quiet">Open chat</Link>
      </div>
    </div>
  );
}
