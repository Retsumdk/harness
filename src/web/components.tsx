import type { ReactNode } from "react";
import { describeError } from "./api";
import { formatBytes, relativeTime } from "./hooks";

export { describeError, formatBytes, relativeTime };

type Tone = "neutral" | "info" | "warn" | "danger" | "ok" | "good" | "idle";

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function Button({
  children, onClick, variant = "default", disabled, busy, title, type = "button", size = "md",
}: {
  children: ReactNode; onClick?: () => void; variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean; busy?: boolean; title?: string; type?: "button" | "submit"; size?: "sm" | "md";
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size}`}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-busy={busy ? "true" : undefined}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** First-run, zero-result and empty-collection states are always written out. */
export function EmptyState({ title, body, action, icon }: { title: string; body?: string; action?: ReactNode; icon?: string }) {
  return (
    <div className="empty" role="status">
      {icon ? <div className="empty-icon" aria-hidden="true">{icon}</div> : null}
      <h3>{title}</h3>
      {body ? <p className="muted">{body}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = "Loading…", rows = 0 }: { label?: string; rows?: number }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="loading-line"><span className="spinner" aria-hidden="true" /> {label}</div>
      {rows > 0 ? <div className="skeleton">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton-row" />)}</div> : null}
    </div>
  );
}

export function ErrorBanner({ message, onRetry, retryLabel = "Try again" }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="error-banner" role="alert">
      <span className="error-dot" aria-hidden="true">!</span>
      <span className="error-text">{message}</span>
      {onRetry ? <Button size="sm" onClick={onRetry}>{retryLabel}</Button> : null}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone: Tone = status === "succeeded" ? "ok" : status === "running" ? "info" : status === "cancelled" ? "neutral" : "danger";
  return <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge>;
}
