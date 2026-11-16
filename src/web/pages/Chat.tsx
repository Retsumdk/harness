import { useEffect, useRef, useState } from "react";
import { useApi } from "../api-context";
import { useRouter, useSearchParams } from "../router";
import { Badge, Button, EmptyState, ErrorBanner, Loading, describeError, relativeTime } from "../components";
import type { Conversation, Message } from "../api";

const SUGGESTIONS = [
  "What is in this workspace?",
  "List the files in notes/",
  "Summarise data/releases.csv",
];

export interface ChatViewProps {
  conversations: Conversation[];
  activeId: string | null;
  messages: Message[];
  loading: boolean;
  listing: boolean;
  streaming: boolean;
  streamText: string;
  error: string | null;
  listError: string | null;
  providers: string[];
  provider: string;
  busy: boolean;
  onSend: (text: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onStop: () => void;
  onProviderChange: (provider: string) => void;
  onRetry: () => void;
}

export function ChatView(props: ChatViewProps) {
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages.length, props.streamText]);

  const submit = () => {
    const text = draft.trim();
    if (!text || props.streaming || props.busy) return;
    setDraft("");
    props.onSend(text);
  };

  return (
    <div className="chat-layout">
      <aside className="chat-side">
        <div className="chat-side-head">
          <h2>Conversations</h2>
          <Button onClick={props.onNew} title="Start a new conversation" variant="primary">New</Button>
        </div>
        {props.listError ? (
          <ErrorBanner message={props.listError} onRetry={props.onRetry} />
        ) : props.listing && !props.conversations.length ? (
          <Loading label="Loading conversations…" rows={4} />
        ) : !props.conversations.length ? (
          <EmptyState title="No conversations yet" body="Send the first message and it will appear here." />
        ) : (
          <ul className="conv-list">
            {props.conversations.map((c) => (
              <li key={c.id} className={c.id === props.activeId ? "conv is-active" : "conv"}>
                <button className="conv-open" onClick={() => props.onSelect(c.id)} title={c.title}>
                  <span className="conv-title">{c.title || "Untitled"}</span>
                  <span className="muted small">{relativeTime(c.createdAt)}</span>
                </button>
                <Button variant="danger" onClick={() => props.onDelete(c.id)} title={`Delete "${c.title}"`}>✕</Button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <div>
            <h2>{props.activeId ? props.conversations.find((c) => c.id === props.activeId)?.title ?? "Conversation" : "New conversation"}</h2>
            <p className="muted small">
              {props.providers.length > 1 ? "Provider" : "Provider"}:{" "}
              <select
                value={props.provider}
                onChange={(e) => props.onProviderChange(e.target.value)}
                aria-label="Provider"
                className="inline-select"
              >
                {props.providers.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </p>
          </div>
          {props.streaming ? <Badge tone="info">streaming</Badge> : null}
        </header>

        {props.error ? <ErrorBanner message={props.error} onRetry={props.onRetry} retryLabel="Retry" /> : null}

        <div className="thread" ref={threadRef}>
          {props.loading ? (
            <Loading label="Loading messages…" />
          ) : !props.messages.length && !props.streamText ? (
            <EmptyState
              icon="◐"
              title="Nothing said yet"
              body="Say something to the model. With the mock provider no key is needed — it echoes you and can call workspace tools."
              action={
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <Button key={s} onClick={() => setDraft(s)} title={`Use: ${s}`}>{s}</Button>
                  ))}
                </div>
              }
            />
          ) : (
            <ol className="messages">
              {props.messages.map((m) => (
                <li key={m.id} className={`msg msg-${m.role}`}>
                  <div className="msg-meta">
                    <Badge tone={m.role === "user" ? "info" : m.role === "tool" ? "warn" : "neutral"}>{m.role}</Badge>
                    <span className="muted small">{relativeTime(m.createdAt)}</span>
                  </div>
                  <div className="msg-body">{m.content || <span className="muted">(no text)</span>}</div>
                  {m.toolCalls?.length ? (
                    <ul className="chips">
                      {m.toolCalls.map((c) => <li key={c.id}><Badge tone="warn">{c.name}</Badge> <code>{JSON.stringify(c.args)}</code></li>)}
                    </ul>
                  ) : null}
                </li>
              ))}
              {props.streaming ? (
                <li className="msg msg-assistant is-streaming">
                  <div className="msg-meta"><Badge tone="info">assistant</Badge><span className="muted small">replying…</span></div>
                  <div className="msg-body">{props.streamText || <span className="caret" aria-hidden="true" />}</div>
                </li>
              ) : null}
            </ol>
          )}
        </div>

        <div className="composer">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            placeholder="Message the workspace…  (/tool fs.list to call a tool with the mock provider)"
            aria-label="Message"
            rows={3}
            maxLength={20000}
          />
          <div className="composer-actions">
            <span className="muted small">Enter sends · Shift+Enter adds a line</span>
            {props.streaming
              ? <Button variant="danger" onClick={props.onStop} title="Stop the reply">Stop</Button>
              : <Button variant="primary" onClick={submit} disabled={!draft.trim()} busy={props.busy} title="Send">Send</Button>}
          </div>
        </div>
      </section>
    </div>
  );
}

export function ChatPage({ conversationId }: { conversationId?: string } = {}) {
  const api = useApi();
  const { navigate } = useRouter();
  const query = useSearchParams();
  const activeId = query.get("c") ?? conversationId ?? null;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [listing, setListing] = useState(true);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);

  const loadList = async () => {
    setListing(true); setListError(null);
    try {
      const list = await api.listConversations();
      setConversations([...list].sort((a, b) => b.createdAt - a.createdAt));
    } catch (e) { setListError(describeError(e)); }
    finally { setListing(false); }
  };

  useEffect(() => { void loadList(); }, []);
  useEffect(() => {
    void api.settings()
      .then((s) => { setProviders(s.providers); setProvider((cur) => cur || s.settings.provider || s.defaultProvider); })
      .catch(() => { /* the composer still works without the provider list */ });
  }, []);

  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    let live = true;
    setLoading(true); setError(null);
    api.getConversation(activeId)
      .then(({ messages: msgs }) => { if (live) setMessages(msgs); })
      .catch((e) => { if (live) setError(describeError(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [activeId]);

  const send = async (text: string) => {
    setError(null); setStreaming(true); setStreamText(""); setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    let conversationId = activeId ?? undefined;
    try {
      const resolved = await api.chat(
        { conversationId, message: text, provider: provider || undefined },
        {
          signal: controller.signal,
          onEvent: (ev) => {
            if (ev.type === "token") setStreamText((t) => t + ev.text);
            else if (ev.type === "error") setError(`${ev.code}: ${ev.message}`);
          },
        },
      );
      conversationId = resolved ?? conversationId;
      await loadList();
      if (conversationId && conversationId !== activeId) navigate(`/chat?c=${encodeURIComponent(conversationId)}`, { replace: true });
      else if (conversationId) {
        const { messages: msgs } = await api.getConversation(conversationId);
        setMessages(msgs);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setStreaming(false); setStreamText(""); setBusy(false); abort.current = null;
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api.deleteConversation(id);
      if (id === activeId) navigate("/chat", { replace: true });
      await loadList();
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  };

  return (
    <ChatView
      conversations={conversations}
      activeId={activeId}
      messages={messages}
      loading={loading}
      listing={listing}
      streaming={streaming}
      streamText={streamText}
      error={error}
      listError={listError}
      providers={providers.length ? providers : [provider || "mock"]}
      provider={provider || providers[0] || "mock"}
      busy={busy && !streaming}
      onSend={(t) => void send(t)}
      onNew={() => navigate("/chat")}
      onSelect={(id) => navigate(`/chat?c=${encodeURIComponent(id)}`)}
      onDelete={(id) => void remove(id)}
      onStop={() => abort.current?.abort()}
      onProviderChange={setProvider}
      onRetry={() => {
        setError(null);
        void loadList();
        if (activeId) void api.getConversation(activeId).then(({ messages: m }) => setMessages(m)).catch((e) => setError(describeError(e)));
      }}
    />
  );
}

export default ChatPage;
