import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Cpu, Activity, Rocket, RefreshCw, Loader, Search, X, Power, AlertTriangle, CheckCircle, XCircle,
} from 'lucide-react';
import type { MacSysinfo, MacProcess, MacAutostart, MacAutostartType } from '../../shared/types';

type TabId = 'system' | 'processes' | 'autostarts';

interface Props {
  isActive: boolean;
}

const REFRESH_MS_SYSTEM = 2000;
const REFRESH_MS_PROCESSES = 3000;

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function MacMCPanel({ isActive }: Props) {
  const [tab, setTab] = useState<TabId>('system');

  return (
    <div className="panel-view macmc-panel">
      <div className="panel-header">
        <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Cpu size={18} />
          <span>MacMC</span>
        </div>
        <div className="macmc-tab-bar">
          <button className={`macmc-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>
            <Activity size={13} /> System
          </button>
          <button className={`macmc-tab ${tab === 'processes' ? 'active' : ''}`} onClick={() => setTab('processes')}>
            <Cpu size={13} /> Prozesse
          </button>
          <button className={`macmc-tab ${tab === 'autostarts' ? 'active' : ''}`} onClick={() => setTab('autostarts')}>
            <Rocket size={13} /> Autostart
          </button>
        </div>
      </div>

      <div className="macmc-body">
        {tab === 'system' && <SystemTab active={isActive && tab === 'system'} />}
        {tab === 'processes' && <ProcessesTab active={isActive && tab === 'processes'} />}
        {tab === 'autostarts' && <AutostartsTab active={isActive && tab === 'autostarts'} />}
      </div>
    </div>
  );
}

// ─── System Tab ──────────────────────────────────────────────────────────────
function SystemTab({ active }: { active: boolean }) {
  const [sysinfo, setSysinfo] = useState<MacSysinfo | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    try {
      const info = await window.electronAPI.getMacSysinfo();
      setSysinfo(info);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    refresh();
    timerRef.current = setInterval(refresh, REFRESH_MS_SYSTEM);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [active]);

  if (loading || !sysinfo) {
    return <div className="macmc-center"><Loader size={20} className="spin" /></div>;
  }

  const memPercent = sysinfo.mem.total > 0 ? (sysinfo.mem.used / sysinfo.mem.total) * 100 : 0;
  const swapPercent = sysinfo.swap.total > 0 ? (sysinfo.swap.used / sysinfo.swap.total) * 100 : 0;
  const diskPercent = sysinfo.disk.total > 0 ? (sysinfo.disk.used / sysinfo.disk.total) * 100 : 0;

  return (
    <div className="macmc-system">
      <div className="macmc-header-info">
        <strong>{sysinfo.hostname}</strong>
        <span className="macmc-os">{sysinfo.os}</span>
        <span className="macmc-uptime">Uptime: {fmtUptime(sysinfo.uptime)}</span>
        <span className="macmc-load">Load: {sysinfo.loadAvg.map(n => n.toFixed(2)).join(' · ')}</span>
      </div>

      <div className="macmc-stat-grid">
        <StatCard label="CPU" value={`${sysinfo.cpu.toFixed(1)}%`} percent={sysinfo.cpu}
          detail={`User ${sysinfo.cpuUser.toFixed(1)}% · Sys ${sysinfo.cpuSystem.toFixed(1)}%`} />
        <StatCard label="RAM" value={`${(sysinfo.mem.used / 1024).toFixed(1)} / ${(sysinfo.mem.total / 1024).toFixed(1)} GB`}
          percent={memPercent} detail={`${memPercent.toFixed(0)}% belegt`} />
        <StatCard label="Swap" value={`${sysinfo.swap.used} / ${sysinfo.swap.total} MB`}
          percent={swapPercent} detail={swapPercent === 0 ? 'kein Swap aktiv' : `${swapPercent.toFixed(0)}% belegt`} />
        <StatCard label="Disk (/)" value={`${sysinfo.disk.used.toFixed(1)} / ${sysinfo.disk.total.toFixed(1)} GB`}
          percent={diskPercent} detail={`${diskPercent.toFixed(0)}% belegt`} />
        <StatCard label="Netzwerk ↓" value={fmtBytes(sysinfo.net.rxBytes)} percent={0} detail="Empfangen" noBar />
        <StatCard label="Netzwerk ↑" value={fmtBytes(sysinfo.net.txBytes)} percent={0} detail="Gesendet" noBar />
        {sysinfo.battery && (
          <StatCard
            label={`Batterie ${sysinfo.battery.charging ? '⚡' : ''}`}
            value={`${sysinfo.battery.percent}%`}
            percent={sysinfo.battery.percent}
            detail={sysinfo.battery.charging ? 'Lädt' : (sysinfo.battery.timeRemaining ? `${Math.floor(sysinfo.battery.timeRemaining / 60)}h ${sysinfo.battery.timeRemaining % 60}m` : 'Akku')}
          />
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, percent, detail, noBar }: { label: string; value: string; percent: number; detail?: string; noBar?: boolean }) {
  const color = percent > 85 ? '#ef4444' : percent > 65 ? '#f59e0b' : '#22c55e';
  return (
    <div className="macmc-stat-card">
      <div className="macmc-stat-label">{label}</div>
      <div className="macmc-stat-value">{value}</div>
      {!noBar && (
        <div className="macmc-stat-bar">
          <div className="macmc-stat-bar-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: color }} />
        </div>
      )}
      {detail && <div className="macmc-stat-detail">{detail}</div>}
    </div>
  );
}

// ─── Processes Tab ───────────────────────────────────────────────────────────
function ProcessesTab({ active }: { active: boolean }) {
  const [procs, setProcs] = useState<MacProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'cpu' | 'mem' | 'pid'>('cpu');
  const [killing, setKilling] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ pid: number; signal: 'TERM' | 'KILL'; cmd: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    try {
      const list = await window.electronAPI.getMacProcesses(150);
      setProcs(list);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    refresh();
    timerRef.current = setInterval(refresh, REFRESH_MS_PROCESSES);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [active]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = q ? procs.filter(p => p.command.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid) === q) : procs;
    list = [...list].sort((a, b) => sortBy === 'pid' ? a.pid - b.pid : b[sortBy] - a[sortBy]);
    return list.slice(0, 100);
  }, [procs, search, sortBy]);

  async function doKill(pid: number, signal: 'TERM' | 'KILL') {
    setKilling(pid);
    try {
      const r = await window.electronAPI.killMacProcess(pid, signal);
      if (!r.success) alert(`Fehler: ${r.error}`);
      await refresh();
    } finally {
      setKilling(null);
      setConfirm(null);
    }
  }

  return (
    <div className="macmc-procs">
      <div className="macmc-procs-toolbar">
        <div className="macmc-procs-search">
          <Search size={13} />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Suche nach Kommando, User, PID" />
          {search && <button className="macmc-procs-clear" onClick={() => setSearch('')}><X size={11} /></button>}
        </div>
        <div className="macmc-procs-sort">
          <span>Sortieren:</span>
          <button className={sortBy === 'cpu' ? 'active' : ''} onClick={() => setSortBy('cpu')}>CPU</button>
          <button className={sortBy === 'mem' ? 'active' : ''} onClick={() => setSortBy('mem')}>RAM</button>
          <button className={sortBy === 'pid' ? 'active' : ''} onClick={() => setSortBy('pid')}>PID</button>
        </div>
        <button className="icon-btn" onClick={refresh} title="Aktualisieren"><RefreshCw size={13} /></button>
      </div>

      {loading ? (
        <div className="macmc-center"><Loader size={20} className="spin" /></div>
      ) : (
        <div className="macmc-procs-list">
          <div className="macmc-procs-row macmc-procs-header">
            <span style={{ width: 56 }}>PID</span>
            <span style={{ width: 100 }}>User</span>
            <span style={{ width: 60 }}>CPU%</span>
            <span style={{ width: 60 }}>MEM%</span>
            <span style={{ width: 80 }}>RSS (MB)</span>
            <span style={{ flex: 1 }}>Kommando</span>
            <span style={{ width: 90, textAlign: 'right' }}>Aktion</span>
          </div>
          {filtered.map(p => (
            <div key={p.pid} className="macmc-procs-row">
              <span style={{ width: 56 }} className="macmc-mono">{p.pid}</span>
              <span style={{ width: 100 }}>{p.user}</span>
              <span style={{ width: 60 }} className={p.cpu > 50 ? 'macmc-hot' : ''}>{p.cpu.toFixed(1)}</span>
              <span style={{ width: 60 }}>{p.mem.toFixed(1)}</span>
              <span style={{ width: 80 }}>{(p.rss / 1024).toFixed(0)}</span>
              <span style={{ flex: 1 }} className="macmc-procs-cmd" title={p.command}>{p.command}</span>
              <span style={{ width: 90, textAlign: 'right', display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                <button
                  className="macmc-procs-kill"
                  title="SIGTERM (sanft beenden)"
                  onClick={() => setConfirm({ pid: p.pid, signal: 'TERM', cmd: p.command })}
                  disabled={killing === p.pid}
                >
                  {killing === p.pid ? <Loader size={11} className="spin" /> : 'TERM'}
                </button>
                <button
                  className="macmc-procs-kill macmc-procs-kill-hard"
                  title="SIGKILL (sofort beenden)"
                  onClick={() => setConfirm({ pid: p.pid, signal: 'KILL', cmd: p.command })}
                  disabled={killing === p.pid}
                >
                  KILL
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {confirm && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal-content" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2><AlertTriangle size={16} style={{ color: '#f59e0b', marginRight: 6, verticalAlign: 'middle' }} />
                Prozess beenden?</h2>
              <button className="modal-close" onClick={() => setConfirm(null)}>×</button>
            </div>
            <div style={{ padding: '0 16px 12px 16px' }}>
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                <strong>PID {confirm.pid}</strong> mit Signal <strong>{confirm.signal}</strong> beenden?
              </p>
              <pre style={{ background: 'var(--bg-secondary)', padding: 8, borderRadius: 4, fontSize: 11, overflow: 'auto', maxHeight: 80 }}>
                {confirm.cmd}
              </pre>
              {confirm.signal === 'KILL' && (
                <p style={{ fontSize: 11, color: '#ef4444', marginTop: 8 }}>
                  ⚠ SIGKILL erzwingt sofortiges Beenden ohne Aufräumen. Daten können verloren gehen.
                </p>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirm(null)}>Abbrechen</button>
              <button className="btn-primary" style={{ background: confirm.signal === 'KILL' ? '#ef4444' : undefined }}
                onClick={() => doKill(confirm.pid, confirm.signal)}>
                <Power size={13} /> Beenden
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Autostarts Tab ──────────────────────────────────────────────────────────
function AutostartsTab({ active }: { active: boolean }) {
  const [items, setItems] = useState<MacAutostart[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<MacAutostartType | 'all'>('all');
  const [toggling, setToggling] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const list = await window.electronAPI.getMacAutostarts();
      setItems(list);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    refresh();
  }, [active]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(it => {
      if (filter !== 'all' && it.type !== filter) return false;
      if (q && !it.label.toLowerCase().includes(q) && !(it.program ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, search, filter]);

  const typeLabel: Record<MacAutostartType, string> = {
    'launch-agent-user': 'User Agent',
    'launch-agent-system': 'System Agent',
    'launch-daemon': 'Daemon',
    'login-item': 'Login Item',
  };
  const typeColor: Record<MacAutostartType, string> = {
    'launch-agent-user': '#3b82f6',
    'launch-agent-system': '#8b5cf6',
    'launch-daemon': '#ef4444',
    'login-item': '#10b981',
  };

  async function doToggle(item: MacAutostart) {
    setToggling(item.id);
    try {
      const r = await window.electronAPI.toggleMacAutostart(item, !item.enabled);
      if (!r.success) {
        alert(`Fehler: ${r.error}\n\nHinweis: System-Agents / Daemons benötigen sudo.`);
      } else {
        await refresh();
      }
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="macmc-autostarts">
      <div className="macmc-procs-toolbar">
        <div className="macmc-procs-search">
          <Search size={13} />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Suche nach Label oder Programm" />
          {search && <button className="macmc-procs-clear" onClick={() => setSearch('')}><X size={11} /></button>}
        </div>
        <div className="macmc-procs-sort">
          <span>Typ:</span>
          {(['all', 'launch-agent-user', 'launch-agent-system', 'launch-daemon', 'login-item'] as const).map(t => (
            <button key={t} className={filter === t ? 'active' : ''} onClick={() => setFilter(t)}>
              {t === 'all' ? 'Alle' : typeLabel[t]}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={refresh} title="Aktualisieren">
          {loading ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {loading && items.length === 0 ? (
        <div className="macmc-center"><Loader size={20} className="spin" /></div>
      ) : (
        <div className="macmc-autostart-list">
          {filtered.length === 0 ? (
            <div className="macmc-center" style={{ color: 'var(--text-secondary)' }}>Keine Einträge</div>
          ) : filtered.map(item => (
            <div key={item.id} className={`macmc-autostart-item ${item.enabled ? 'enabled' : 'disabled'}`}>
              <div className="macmc-autostart-status">
                {item.enabled ? <CheckCircle size={14} style={{ color: '#22c55e' }} /> : <XCircle size={14} style={{ color: '#6b7280' }} />}
              </div>
              <div className="macmc-autostart-info">
                <div className="macmc-autostart-label">
                  <span>{item.label}</span>
                  <span className="macmc-autostart-type" style={{ background: typeColor[item.type] }}>
                    {typeLabel[item.type]}
                  </span>
                </div>
                <div className="macmc-autostart-path" title={item.program || item.path}>
                  {item.program || item.path}
                </div>
              </div>
              <button
                className={`macmc-autostart-toggle ${item.enabled ? 'on' : 'off'}`}
                onClick={() => doToggle(item)}
                disabled={toggling === item.id}
                title={item.enabled ? 'Deaktivieren' : 'Aktivieren'}
              >
                {toggling === item.id
                  ? <Loader size={11} className="spin" />
                  : item.enabled ? 'Aus' : 'An'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
