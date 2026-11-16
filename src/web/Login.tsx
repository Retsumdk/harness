import { useState } from "react";
import { Button, Field } from "./components";

/**
 * Single-user sign-in: the browser holds the same bearer token the HTTP API uses.
 * Nothing is validated here except shape — the first API call is the real check,
 * so a wrong token produces the server's own message instead of a guess.
 */
export function LoginScreen({
  onSubmit, error, busy,
}: {
  onSubmit: (token: string) => void; error?: string | null; busy?: boolean;
}) {
  const [token, setToken] = useState("");
  const [touched, setTouched] = useState(false);
  const empty = !token.trim();

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          <span className="brand-glyph">H</span>
        </div>
        <h1>HARNESS</h1>
        <p className="muted">A modular AI workspace: chat, files, tools, plugins and agent runs on one machine.</p>

        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (empty) return;
            onSubmit(token.trim());
          }}
        >
          <Field
            label="Access token"
            hint="Stored in this browser only. It is the HARNESS_TOKEN printed when the server starts."
            error={touched && empty ? "Enter the token to continue." : null}
          >
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="paste your access token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-label="Access token"
            />
          </Field>
          {error ? <div className="error-banner" role="alert"><span className="error-dot" aria-hidden="true">!</span><span className="error-text">{error}</span></div> : null}
          <Button type="submit" variant="primary" busy={busy} disabled={empty && touched}>
            Open workspace
          </Button>
        </form>

        <p className="auth-foot muted">
          No token yet? Run the server once — it prints one — or set <code>HARNESS_TOKEN</code> in <code>.env</code>.
        </p>
      </div>
    </main>
  );
}
