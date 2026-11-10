import { useEffect, useState } from 'react';
import type { Invoke } from '../engine';
import { STATE_LABEL, getDataOverview, savedPercent, type DataOverview, type ToolState } from '../data';

const ORDER: ToolState[] = ['on', 'trial', 'untested', 'off', 'unknown'];

export function Tools({ invoke }: { invoke: Invoke | null }) {
  const [data, setData] = useState<DataOverview | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!invoke) return;
    let live = true;
    getDataOverview(invoke)
      .then((d) => live && setData(d))
      .catch((err: unknown) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [invoke]);

  if (!invoke) return <section className="card"><p className="key-note bad">The Tools page needs the desktop app.</p></section>;
  if (error) {
    return (
      <section className="card">
        <p className="key-note bad" role="alert">{error}</p>
        <p className="muted">Check the data folder in Settings → Budget and models.</p>
      </section>
    );
  }
  if (!data) return <section className="card"><p className="muted">Reading your data folder…</p></section>;
  if (!data.configured) {
    return (
      <section className="card">
        <p>Set your data folder in Settings → Budget and models to see your tools here.</p>
        <p className="muted">It’s the folder where your private ai-prototype-data repo is cloned.</p>
      </section>
    );
  }

  const tools = [...data.tools].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  const onCount = data.tools.filter((t) => t.state === 'on').length;
  return (
    <section className="card tools">
      <p className="muted">
        {onCount} of {data.tools.length} tools on · {data.habits.length} habits · {data.ruleCount} rules
      </p>
      <p className="muted">
        The engine reads a short summary first: about {data.firstReadTokens.toLocaleString('en-GB')} tokens instead of{' '}
        {data.allTokens.toLocaleString('en-GB')} for everything ({savedPercent(data.firstReadTokens, data.allTokens)} fewer).
      </p>
      <ul className="tool-list">
        {tools.map((t) => (
          <li key={t.name} className="tool-row">
            <button
              type="button"
              className="tool-head"
              aria-expanded={open === t.name}
              onClick={() => setOpen(open === t.name ? null : t.name)}
            >
              <span className="tool-name">{t.name}</span>
              <span className={`tool-state ${t.state}`}>{STATE_LABEL[t.state]}</span>
            </button>
            <p className="tool-what">{t.what || t.job}</p>
            {open === t.name && (
              <dl className="tool-detail">
                <dt>Status</dt>
                <dd>{t.status}</dd>
                {t.useWhen && (<><dt>Use when</dt><dd>{t.useWhen}</dd></>)}
                {t.dontUseWhen && (<><dt>Don’t use when</dt><dd>{t.dontUseWhen}</dd></>)}
                {t.evidence && (<><dt>Evidence</dt><dd>{t.evidence}</dd></>)}
                {t.cost && (<><dt>Cost</dt><dd>{t.cost}</dd></>)}
                <dt>Your rating</dt>
                <dd>{t.rating && t.rating !== '-' ? `${t.rating} / 5` : 'not rated yet'}</dd>
              </dl>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
