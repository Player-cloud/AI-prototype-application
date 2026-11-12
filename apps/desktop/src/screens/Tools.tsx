import { useEffect, useState } from 'react';
import type { Invoke } from '../engine';
import { STATE_LABEL, checkThisComputer, decideUpdate, getDataOverview, lookForUpdates, runExperiment, runFreeTests, rateTool, savedPercent, switchToolOn, syncData, type DataOverview, type Environment, type ToolRow, type ToolState } from '../data';

const ORDER: ToolState[] = ['on', 'trial', 'untested', 'off', 'unknown'];

/** "4.15.0 (tested on 4.14.0)", or unknown when the app hasn't seen it in use yet (CI-1). */
export function versionText(t: Pick<ToolRow, 'version' | 'testedVersion' | 'stale'>): string {
  if (!t.version) return 'unknown (not seen in use yet)';
  if (t.testedVersion && t.testedVersion !== t.version) return `${t.version} (its evidence is for ${t.testedVersion}${t.stale ? ', retest due' : ''})`;
  return t.version;
}

const MARK = (ok: boolean | null) => (ok === true ? '✓' : ok === false ? '✗' : '?');

/** CI-2: this computer and the others, what differs between them, and clashing tools. */
export function Computers({ data, busy, onCheck }: { data: Extract<DataOverview, { configured: true }>; busy: boolean; onCheck: () => void }) {
  const envs = data.environments ?? [];
  const mine = envs.find((e) => e.computer === data.computer);
  const others = envs.filter((e) => e.computer !== data.computer);
  const problems = (e: Environment) => e.checks.filter((c) => c.ok === false).length;
  const when = (e: Environment) => new Date(e.checkedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="computers" role="region" aria-label="Computers">
      <h3>This computer{data.computer ? ` (${data.computer})` : ''}</h3>
      {mine ? (
        <>
          <p className="muted">Checked {when(mine)} · {mine.os}</p>
          <ul className="claim-list" aria-label="This computer’s checks">
            {mine.checks.map((c) => (
              <li key={c.name} className={c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'unchecked'}>
                <span aria-hidden="true">{MARK(c.ok)} </span>
                {c.name}: {c.detail}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">Not checked yet. The check looks at Node, pnpm, git, the browser for pictures and the check tools. It’s free and changes nothing.</p>
      )}
      <button type="button" disabled={busy} onClick={onCheck}>
        Check this computer (free)
      </button>
      {others.length > 0 && (
        <>
          <h3>Other computers</h3>
          <ul>
            {others.map((e) => (
              <li key={e.computer}>
                {e.computer} · {e.os} · checked {when(e)} · {problems(e) ? `${problems(e)} to fix` : 'all fine'}
              </li>
            ))}
          </ul>
        </>
      )}
      {(data.differences ?? []).length > 0 && (
        <>
          <h3>Different versions between computers</h3>
          <ul aria-label="Different versions between computers">
            {data.differences!.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <p className="muted">Not a fault on its own, but the likeliest reason a build works on one computer and not the other.</p>
        </>
      )}
      {(data.clashes ?? []).length > 0 && (
        <>
          <h3>Tools that clash</h3>
          <ul aria-label="Tools that clash">
            {data.clashes!.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

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

  function checkComputer() {
    if (!invoke || !data?.configured) return;
    void work('Checking this computer…', async () => {
      const r = await checkThisComputer(invoke);
      const environments = [r.environment, ...(data.environments ?? []).filter((e) => e.computer !== r.environment.computer)];
      setData({ ...data, computer: r.environment.computer, environments, differences: r.differences });
      const bad = r.environment.checks.filter((c) => c.ok === false).length;
      return { summary: `${bad ? `${bad} thing${bad === 1 ? '' : 's'} to fix on this computer.` : 'This computer has everything the app needs.'}${r.synced ? ` ${r.synced}` : ''}` };
    });
  }

  function freeTests() {
    if (!invoke) return;
    void work('Running the free tests (about half a minute)…', async () => {
      const r = await runFreeTests(invoke);
      setData(await getDataOverview(invoke));
      const bad = r.results.filter((x) => x.outcome !== 'passed').map((x) => `${x.suite}: ${x.outcome}${x.detail ? ` (${x.detail})` : ''}`);
      return { summary: [r.summary, ...bad, ...(r.regressions ?? []), r.synced].filter(Boolean).join(' ') };
    });
  }

  function updates() {
    if (!invoke) return;
    void work('Looking for updates (free, installs nothing)…', async () => {
      const r = await lookForUpdates(invoke);
      setData(await getDataOverview(invoke));
      return { summary: [r.summary, r.synced].filter(Boolean).join(' ') };
    });
  }

  function decide(pkg: string, to: string, ok: boolean) {
    if (!invoke) return;
    void work(ok ? 'Noting your OK…' : 'Noting your no…', async () => {
      const r = await decideUpdate(invoke, pkg, to, ok);
      setData(await getDataOverview(invoke));
      return { summary: [r.summary, r.synced].filter(Boolean).join(' ') };
    });
  }

  function experiment(t: ToolRow) {
    if (!invoke) return;
    void work(`Running ${t.name}’s test 3 times in a row…`, async () => {
      const r = await runExperiment(invoke, t.id);
      setData(await getDataOverview(invoke));
      return { summary: [r.summary, r.synced].filter(Boolean).join(' ') };
    });
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
        <button type="button" disabled={busy} onClick={freeTests}>
          Run free tests
        </button>
        <button type="button" disabled={busy} onClick={updates}>
          Look for updates
        </button>
      </div>
      {note && (
        <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
      <Computers data={data} busy={busy} onCheck={checkComputer} />
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
            {t.regression && <p className="tool-health warn">{t.regression}</p>}
            {t.switchedOff && (
              <button type="button" disabled={busy} onClick={() => switchOn(t.name)}>
                Switch {t.name} back on
              </button>
            )}
            {open === t.name && (
              <dl className="tool-detail">
                <dt>Status</dt>
                <dd>{t.status}</dd>
                <dt>ID</dt>
                <dd>{t.id ?? 'unknown'}</dd>
                <dt>Kind</dt>
                <dd>{t.kind ?? 'unknown'}</dd>
                <dt>Version</dt>
                <dd>{versionText(t)}</dd>
                {t.byComputer && (<><dt>On each computer</dt><dd>{t.byComputer}</dd></>)}
                <dt>Tested by the app</dt>
                <dd>
                  {t.tested || 'Untested (no repeatable test has run yet).'}
                  {t.testable && (
                    <button type="button" disabled={busy} onClick={() => experiment(t)}>
                      Is it steady? (runs its test 3 times, free)
                    </button>
                  )}
                </dd>
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
      {(data.updates ?? []).some((u) => u.status === 'found' || u.status === 'approved') && (
        <div className="updates" role="region" aria-label="Updates">
          <h3>Updates</h3>
          <p className="muted">Found, not installed. The app never installs an update: after your OK it shows the command to run.</p>
          <ul>
            {data.updates!
              .filter((u) => u.status === 'found' || u.status === 'approved')
              .map((u) => (
                <li key={`${u.package}@${u.to}`}>
                  {u.text}
                  {u.status === 'found' && (
                    <>
                      {' '}
                      <button type="button" disabled={busy} onClick={() => decide(u.package, u.to, true)} aria-label={`OK ${u.package} ${u.to}`}>
                        OK
                      </button>
                      <button type="button" disabled={busy} onClick={() => decide(u.package, u.to, false)} aria-label={`No to ${u.package} ${u.to}`}>
                        No
                      </button>
                    </>
                  )}
                  {u.command && <code className="command">{u.command}</code>}
                </li>
              ))}
          </ul>
        </div>
      )}
      {(data.docIssues ?? []).length > 0 && (
        <div className="doc-check" role="region" aria-label="Doc check">
          <h3>Instructions to check</h3>
          <p className="muted">Your rules, habits, project rules and tool cards, read for ones that look out of date or clash. Nothing was changed: edit the file if you agree.</p>
          <ul>
            {data.docIssues!.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      {(data.experiments ?? []).length > 0 && (
        <div className="experiments" role="region" aria-label="Experiments">
          <h3>Experiments</h3>
          <ul>
            {data.experiments!.map((e) => (
              <li key={e.id}>
                {e.question} {e.verdict} <span className="muted">({e.status === 'proposal' ? 'a proposal: nothing was changed' : e.status}, {new Date(e.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
