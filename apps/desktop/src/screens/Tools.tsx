import { useEffect, useState } from 'react';
import type { Invoke } from '../engine';
import { STATE_LABEL, getDataOverview, rateTool, savedPercent, switchToolOn, syncData, type DataOverview, type ToolState } from '../data';

const ORDER: ToolState[] = ['on', 'trial', 'untested', 'off', 'unknown'];

export function Tools({ invoke }: { invoke: Invoke | null }) {
  const [data, setData] = useState<DataOverview | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

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

  async function work(label: string, job: () => Promise<{ summary: string }>, after?: () => void) {
    setBusy(true);
    setNote({ text: label, bad: false });
    try {
      const r = await job();
      after?.();
      setNote({ text: r.summary, bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  function rate(tool: string, rating: number) {
    if (!invoke || !data?.configured) return;
    void work(`Saving ${rating}/5 and syncing…`, () => rateTool(invoke, tool, rating), () =>
      setData({ ...data, tools: data.tools.map((t) => (t.name === tool ? { ...t, rating: String(rating) } : t)) }),
    );
  }

  function switchOn(tool: string) {
    if (!invoke || !data?.configured) return;
    void work(`Switching ${tool} back on…`, () => switchToolOn(invoke, tool), () =>
      setData({
        ...data,
        tools: data.tools.map((t) =>
          t.name === tool ? { ...t, switchedOff: false, failuresInRow: 0, health: 'It gets a quick retest next time it’s used.' } : t,
        ),
      }),
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
      <div className="key-controls">
        <button type="button" disabled={busy} onClick={() => invoke && void work('Syncing with GitHub…', () => syncData(invoke))}>
          Sync with GitHub
        </button>
      </div>
      {note && (
        <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
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
            {t.health && <p className={`tool-health${t.switchedOff || t.failuresInRow > 0 ? ' warn' : ''}`}>{t.health}</p>}
            {t.switchedOff && (
              <button type="button" disabled={busy} onClick={() => switchOn(t.name)}>
                Switch {t.name} back on
              </button>
            )}
            {open === t.name && (
              <dl className="tool-detail">
                <dt>Status</dt>
                <dd>{t.status}</dd>
                {t.useWhen && (<><dt>Use when</dt><dd>{t.useWhen}</dd></>)}
                {t.dontUseWhen && (<><dt>Don’t use when</dt><dd>{t.dontUseWhen}</dd></>)}
                {t.evidence && (<><dt>Evidence</dt><dd>{t.evidence}</dd></>)}
                {t.cost && (<><dt>Cost</dt><dd>{t.cost}</dd></>)}
                <dt>Your rating</dt>
                <dd>
                  <span className="rating" role="group" aria-label={`Rate ${t.name}`}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        disabled={busy || t.status === 'not in the ledger yet'}
                        aria-pressed={t.rating === String(n)}
                        onClick={() => rate(t.name, n)}
                      >
                        {n}
                      </button>
                    ))}
                  </span>{' '}
                  {t.rating && t.rating !== '-' ? `${t.rating} / 5` : 'not rated yet'}
                </dd>
              </dl>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
