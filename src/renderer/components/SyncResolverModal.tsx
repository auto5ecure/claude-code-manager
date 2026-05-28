import { useEffect, useState, useCallback } from 'react';

type DetectedState = Awaited<ReturnType<NonNullable<Window['electronAPI']>['coworkDetectSyncState']>>;

interface SyncResolverModalProps {
  repoPath: string;
  repoName: string;
  onClose: () => void;
  onResolved?: () => void;
}

export default function SyncResolverModal({ repoPath, repoName, onClose, onResolved }: SyncResolverModalProps) {
  const [state, setState] = useState<DetectedState | null>(null);
  const [actionLog, setActionLog] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setState(null);
    const r = await window.electronAPI?.coworkDetectSyncState(repoPath);
    setState(r || null);
  }, [repoPath]);

  useEffect(() => { reload(); }, [reload]);

  async function rebaseAction(action: 'abort' | 'continue' | 'skip') {
    setBusy(true);
    const r = await window.electronAPI?.coworkRebaseAction(repoPath, action);
    setActionLog(prev => `${prev}\n$ git rebase --${action}\n${r?.success ? r.output || '(ok)' : `ERROR: ${r?.error}`}\n`);
    setBusy(false);
    await reload();
    // Auto-close when state is clean — but keep the log visible if user wants to read
    const post = await window.electronAPI?.coworkDetectSyncState(repoPath);
    if (post && 'state' in post && post.state === 'clean') {
      onResolved?.();
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sync-resolver" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Sync-Resolver — {repoName}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {!state && <div>Lade Status...</div>}
          {state && 'error' in state && (
            <div className="sync-resolver-err">Fehler: {state.error}</div>
          )}
          {state && 'state' in state && state.state === 'clean' && (
            <div>
              <div className="sync-resolver-ok">✓ Sync-Status: clean — nichts zu tun.</div>
              <div className="modal-hint">Branch: <code>{state.branch || '?'}</code></div>
            </div>
          )}

          {state && 'state' in state && state.state === 'stuck-rebase' && state.stuckRebase && (
            <div>
              <div className="sync-resolver-warn">⚠ Hängender Rebase erkannt</div>
              <div className="sync-resolver-grid">
                <div>Branch:</div><div><code>{state.stuckRebase.headName || state.branch || '?'}</code></div>
                <div>Onto:</div><div><code>{state.stuckRebase.onto?.slice(0, 12) || '?'}</code></div>
                <div>Fertig:</div><div>{state.stuckRebase.doneCount} Picks</div>
                <div>Offen:</div><div>{state.stuckRebase.remainingCount} Picks</div>
              </div>
              <details style={{ marginTop: 10 }}>
                <summary>Picks anzeigen</summary>
                <div className="sync-resolver-picks">
                  {state.stuckRebase.doneCommits.length > 0 && (
                    <>
                      <div className="sync-resolver-picks-label">✓ Fertig:</div>
                      {state.stuckRebase.doneCommits.map((c, i) => <div key={i} className="sync-resolver-pick done">{c}</div>)}
                    </>
                  )}
                  {state.stuckRebase.remainingCommits.length > 0 && (
                    <>
                      <div className="sync-resolver-picks-label">⏳ Offen:</div>
                      {state.stuckRebase.remainingCommits.map((c, i) => <div key={i} className="sync-resolver-pick pending">{c}</div>)}
                    </>
                  )}
                </div>
              </details>
              <div className="sync-resolver-actions">
                <button className="modal-btn" onClick={() => rebaseAction('abort')} disabled={busy} title="LocateV2 bleibt unverändert auf dem Stand vor dem Rebase">
                  ✕ Abort (verwerfen)
                </button>
                <button className="modal-btn primary" onClick={() => rebaseAction('continue')} disabled={busy} title="Letzten Pick durchlaufen lassen">
                  ▶ Continue
                </button>
                <button className="modal-btn" onClick={() => rebaseAction('skip')} disabled={busy} title="Aktuellen Pick überspringen">
                  ⏭ Skip
                </button>
              </div>
            </div>
          )}

          {state && 'state' in state && state.state === 'conflicts' && state.conflicts && (
            <div>
              <div className="sync-resolver-warn">⚠ {state.conflicts.length} ungelöste Konflikt(e)</div>
              <div className="modal-hint">Per-File-Resolver folgt in Phase B. Vorerst: aborten oder von Hand lösen.</div>
              <ul style={{ marginTop: 10, paddingLeft: 18 }}>
                {state.conflicts.map(c => (
                  <li key={c.path}><code>{c.xy}</code> {c.path}</li>
                ))}
              </ul>
            </div>
          )}

          {actionLog && (
            <details open style={{ marginTop: 12 }}>
              <summary>Action-Log</summary>
              <pre className="sync-resolver-log">{actionLog}</pre>
            </details>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={reload} disabled={busy}>↻ Status neu prüfen</button>
          <button className="modal-btn primary" onClick={onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}
