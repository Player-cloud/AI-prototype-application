import { useEffect, useState } from 'react';
import type { Invoke } from '../engine';
import { getSettings } from '../settings';
import { runMaintenance, type MaintenanceResult } from '../data';

const LABEL: Record<string, string> = { waiting: 'Ready for your Keep', 'rolled back': 'Rolled back', skipped: 'Left to you' };

/** Tools → Updates: run the app’s own dev-tool patch updates (Q-5) and show what happened. Nothing here merges anything. */
export function MaintenancePanel({ invoke }: { invoke: Invoke }) {
  const [state, setState] = useState<{ on: boolean; slugs: string[] } | null>(null);
  const [results, setResults] = useState<MaintenanceResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    getSettings(invoke)
      .then((s) => live && setState({ on: s.maintenance?.patchUpdates === true, slugs: Object.keys(s.codeFolders ?? {}).sort() }))
      .catch(() => undefined); // no settings: nothing to show
    return () => {
      live = false;
    };
  }, [invoke]);

  if (!state) return null;

  async function run() {
    setBusy(true);
    setError('');
    const out: MaintenanceResult[] = [];
    try {
      for (const slug of state!.slugs) out.push(await runMaintenance(invoke, slug));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResults(out);
      setBusy(false);
    }
  }

  return (
    <div className="maintenance-panel" role="region" aria-label="Dev-tool patch updates">
      <h3>Dev-tool patch updates</h3>
      {!state.on ? (
        <p className="muted">Off. The app does nothing by itself. You can turn this on in Settings.</p>
      ) : (
        <>
          <p className="muted">
            For each project with a code folder, the app tries up to 3 dev-tool patch updates in a separate copy, with your tests and the free checks. Ones that pass wait in Build for your Keep. Nothing is merged or pushed.
          </p>
          <button type="button" disabled={busy || state.slugs.length === 0} onClick={() => void run()}>
            Prepare dev-tool patch updates now
          </button>
          {state.slugs.length === 0 && <p className="muted"> No project has a code folder yet.</p>}
        </>
      )}
      {busy && <p role="status">Trying the updates (this can take a few minutes)…</p>}
      {error && <p className="key-note bad" role="alert">{error}</p>}
      {results.map((r) => (
        <div key={r.slug}>
          <p role="status">
            <strong>{r.slug}:</strong> {r.summary}
          </p>
          {r.items.length > 0 && (
            <ul aria-label={`Updates tried in ${r.slug}`}>
              {r.items.map((i) => (
                <li key={`${i.package}@${i.to}`} className={i.outcome === 'rolled back' ? 'warn' : undefined}>
                  {i.package} {i.from} → {i.to}: <strong>{LABEL[i.outcome]}.</strong> {i.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
