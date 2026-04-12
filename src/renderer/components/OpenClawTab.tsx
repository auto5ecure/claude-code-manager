import { useState, useEffect, useRef } from 'react';

interface OpenClawTabProps {
  isActive: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
}

export default function OpenClawTab({ isActive }: OpenClawTabProps) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isActive) {
      inputRef.current?.focus();
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isActive]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function checkStatus() {
    const status = await window.electronAPI?.openclawStatus?.();
    if (status) {
      setInstalled(status.installed);
      setRunning(status.running);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setSending(true);

    const result = await window.electronAPI?.openclawSend?.(text);
    setSending(false);

    const reply: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: result?.success ? 'assistant' : 'system',
      text: result?.reply || result?.error || 'Keine Antwort',
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, reply]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function openWebUI() {
    window.electronAPI?.openExternal('http://localhost:18789');
  }

  // ── Not installed ─────────────────────────────────────────
  if (installed === false) {
    return (
      <div className="openclaw-tab openclaw-not-running">
        <div className="openclaw-status-card">
          <div className="openclaw-logo">🦞</div>
          <h3>OpenClaw nicht installiert</h3>
          <p>OpenClaw ist ein persönlicher KI-Assistent der lokal auf deinem Rechner läuft.</p>
          <code className="openclaw-install-cmd">npm install -g openclaw@latest</code>
          <p className="openclaw-hint">Danach: <code>openclaw onboard --install-daemon</code></p>
        </div>
      </div>
    );
  }

  // ── Not running ───────────────────────────────────────────
  if (installed && !running) {
    return (
      <div className="openclaw-tab openclaw-not-running">
        <div className="openclaw-status-card">
          <div className="openclaw-logo">🦞</div>
          <h3>OpenClaw nicht aktiv</h3>
          <p>Der OpenClaw Daemon läuft nicht. Starte ihn im Terminal:</p>
          <code className="openclaw-install-cmd">openclaw start</code>
        </div>
      </div>
    );
  }

  // ── Chat UI ───────────────────────────────────────────────
  return (
    <div className="openclaw-tab">
      <div className="openclaw-header">
        <span className="openclaw-title">🦞 OpenClaw</span>
        <span className="openclaw-status-dot" title={running ? 'Verbunden' : 'Getrennt'}>
          {running ? '● Verbunden' : '○ Getrennt'}
        </span>
        <button className="openclaw-webui-btn" onClick={openWebUI} title="Web UI öffnen">
          ↗ Web UI
        </button>
      </div>

      <div className="openclaw-messages">
        {messages.length === 0 && (
          <div className="openclaw-empty">
            Schreibe eine Nachricht an OpenClaw…
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`openclaw-msg openclaw-msg-${msg.role}`}>
            <div className="openclaw-msg-bubble">{msg.text}</div>
            <div className="openclaw-msg-time">
              {msg.timestamp.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        ))}
        {sending && (
          <div className="openclaw-msg openclaw-msg-assistant">
            <div className="openclaw-msg-bubble openclaw-typing">…</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="openclaw-input-area">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Nachricht an OpenClaw…"
          className="openclaw-input"
          disabled={sending || !running}
        />
        <button
          className="openclaw-send-btn"
          onClick={sendMessage}
          disabled={sending || !input.trim() || !running}
        >
          {sending ? '…' : '↵'}
        </button>
      </div>
    </div>
  );
}
