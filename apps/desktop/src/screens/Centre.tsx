import { useEffect, useState } from 'react';
import type { Invoke } from '../engine';
import { LIFECYCLES, getCentre, setTrust, type Centre as CentreData, type Lifecycle, type Trust } from '../data';

const LABEL: Record<Lifecycle, string> = {
  'in use': 'In use',
  stale: 'Changed since tested',
  'on trial': 'On trial',
  'not tested': 'Not tested',
  'switched off': 'Switched off',
  retired: 'Retired',
};

const TRUST_WORDS: Record<Trust, string> = {
  unknown: 'Not checked yet. It becomes “checked” by itself once it passes its health check.',
  checked: 'Checked: it passed its health check. Only you can trust it.',
  trusted: 'Trusted by you.',
};

/**
 * UI-01: the Capability Centre. Every line comes from a real record; where there isn't one it
 * says so. Scores are never added up into one grade, and it changes nothing.
 */
export function Centre({ invoke }: { invoke: Invoke | null }) {
  const [data, setData] = useState<CentreData | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Lifecycle | 'all'>('all');
  const [trustError, setTrustError] = useState('');

  useEffect(() => {
    if (!invoke) return;
    let live = true;
    getCentre(invoke)
      .then((d) => live && setData(d))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [invoke]);

  if (!invoke) return <section className="card"><p className="key-note bad">The Capability Centre needs the desktop app.</p></section>;
  if (error) return <section className="card"><p className="key-note bad" role="alert">{error}</p></section>;
  if (!data) return <section className="card"><p className="muted">Reading your records…</p></section>;
  if (!data.configured) return <section className="card"><p className="muted">Set your data folder in Settings first: the Centre is built from the records kept there.</p></section>;

  // joshua's button. Scores, ratings and health never change trust; only this does.
  const changeTrust = async (id: string, name: string, trust: Trust) => {
    setTrustError('');
    try {
      await setTrust(invoke, name, trust);
      setData((d) => (d && d.configured ? { ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, trust } : r)) } : d));
    } catch (err) {
      setTrustError((err as Error).message);
    }
  };

  const rows = filter === 'all' ? data.rows : data.rows.filter((r) => r.lifecycle === filter);
  return (
    <section className="card centre">
      <div className="filters" role="group" aria-label="Lifecycle">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All ({data.rows.length})
        </button>
        {LIFECYCLES.filter((l) => data.counts[l] > 0).map((l) => (
          <button key={l} type="button" aria-pressed={filter === l} onClick={() => setFilter(l)}>
            {LABEL[l]} ({data.counts[l]})
          </button>
        ))}
      </div>

      <div className="recommendations" role="region" aria-label="Next steps">
        <h3>Next steps</h3>
        {data.recommendations.length ? (
          <ul>
            {data.recommendations.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing to do: the records don’t point to anything.</p>
        )}
        <p className="muted">Suggestions only. Nothing is installed or switched from here; only the trust buttons below change anything, and only when you press them.</p>
      </div>

      {trustError && <p className="key-note bad" role="alert">{trustError}</p>}
      <ul className="tool-list" aria-label="Capabilities">
        {rows.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.name}</strong> <span className="muted">{r.kind === 'unknown' ? '' : r.kind}</span>{' '}
              <span className={`state ${r.lifecycle.replace(' ', '-')}`}>{LABEL[r.lifecycle]}</span>
            </div>
            <dl>
              <dt>Why</dt>
              <dd>{r.why}</dd>
              <dt>Version</dt>
              <dd>{r.version ?? 'unknown (not seen in use yet)'}</dd>
              <dt>Free tests</dt>
              <dd>{r.tests}</dd>
              {r.regression && (
                <>
                  <dt>After an update</dt>
                  <dd className="tool-health warn">{r.regression}</dd>
                </>
              )}
              {r.builds && (
                <>
                  <dt>Real builds</dt>
                  <dd>{r.builds}</dd>
                </>
              )}
              {r.computers && (
                <>
                  <dt>Computers</dt>
                  <dd>{r.computers}</dd>
                </>
              )}
              {r.health && (
                <>
                  <dt>Health</dt>
                  <dd>{r.health}</dd>
                </>
              )}
              <dt>Your rating</dt>
              <dd>{r.rating}</dd>
              <dt>Trust</dt>
              <dd>
                <span className={`trust ${r.trust}`}>{TRUST_WORDS[r.trust]}</span>{' '}
                {r.trust === 'checked' && (
                  <button type="button" onClick={() => void changeTrust(r.id, r.name, 'trusted')}>
                    Trust this tool
                  </button>
                )}
                {r.trust === 'trusted' && (
                  <button type="button" onClick={() => void changeTrust(r.id, r.name, 'checked')}>
                    Stop trusting
                  </button>
                )}
              </dd>
            </dl>
          </li>
        ))}
      </ul>

      <div className="comparisons" role="region" aria-label="Ways of building compared">
        <h3>Ways of building compared</h3>
        <ul>
          {data.comparisons.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
