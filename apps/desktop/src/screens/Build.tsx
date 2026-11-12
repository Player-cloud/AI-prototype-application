import { useEffect, useState } from 'react';
import type { Invoke } from '../engine';
import { listProjects, openProject, type Feature, type ProjectRow } from '../projects';
import { getSettings } from '../settings';
import { CHECK_NAME, decideRun, keepable, listRuns, listWork, pollPhone, rateRun, startBuild, stopBuild, type BuildResult, type BuildRun, type BuildStep, type MakeChannel, type WorkItem } from '../build';

type Note = { text: string; bad: boolean } | null;

const STATUS: Record<BuildRun['status'], string> = { built: 'waiting for Keep or Undo', kept: 'kept', undone: 'undone' };

/** How often the screen refreshes Builds and Needs you, to show what was done from the phone. */
const REFRESH_MS = 30_000;

/** "£0.80 ($1.01)" */
export function limitText(gbp: number, gbpPerUsd: number): string {
  return `£${gbp.toFixed(2)} ($${(gbp / gbpPerUsd).toFixed(2)})`;
}

/** Step 8c: pick a finished project and one feature, build it, and watch each step live. */
export function Build({ invoke, makeChannel }: { invoke: Invoke | null; makeChannel: MakeChannel | null }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [slug, setSlug] = useState('');
  const [features, setFeatures] = useState<Feature[]>([]);
  const [feature, setFeature] = useState('');
  const [limit, setLimit] = useState('');
  const [using, setUsing] = useState('');
  const [steps, setSteps] = useState<BuildStep[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [runs, setRuns] = useState<BuildRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [learned, setLearned] = useState<string[]>([]);
  const [work, setWork] = useState<WorkItem[]>([]);

  useEffect(() => {
    if (!invoke) return;
    let live = true;
    Promise.all([listProjects(invoke), getSettings(invoke)])
      .then(([rows, s]) => {
        if (!live) return;
        const done = rows.filter((r) => r.finished);
        setProjects(done);
        setLimit(limitText(s.runCapGbp ?? 0.8, s.gbpPerUsd));
        if (done[0]) setSlug(done[0].slug);
      })
      .catch((err: Error) => live && setNote({ text: err.message, bad: true }));
    listWork(invoke)
      .then((w) => live && setWork(w))
      .catch((err: Error) => live && setNote({ text: err.message, bad: true }));
    return () => {
      live = false;
    };
  }, [invoke]);

  useEffect(() => {
    if (!invoke || !slug) return;
    let live = true;
    openProject(invoke, slug)
      .then((v) => {
        if (!live) return;
        setFeatures(v.interview.features);
        setFeature(v.interview.features[0]?.id ?? '');
      })
      .catch((err: Error) => live && setNote({ text: err.message, bad: true }));
    listRuns(invoke, slug)
      .then((r) => live && setRuns(r))
      .catch((err: Error) => live && setNote({ text: err.message, bad: true }));
    return () => {
      live = false;
    };
  }, [invoke, slug]);

  // Replies from the phone are read in the background (about once a minute); keep the lists fresh.
  useEffect(() => {
    if (!invoke || !slug) return;
    const t = setInterval(() => {
      listWork(invoke).then(setWork, () => undefined);
      listRuns(invoke, slug).then(setRuns, () => undefined);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [invoke, slug]);

  if (!invoke || !makeChannel) {
    return (
      <section className="card">
        <p className="key-note bad">Building needs the desktop app.</p>
      </section>
    );
  }

  async function onBuild() {
    if (!invoke || !makeChannel) return;
    setRunning(true);
    setUsing('');
    setSteps([]);
    setResult(null);
    setNote(null);
    try {
      const r = await startBuild(invoke, makeChannel, slug, feature, (e) => {
        if (e.type === 'using') setUsing(e.using);
        else setSteps((s) => [...s, e.refused ? { text: e.text, refused: e.refused } : { text: e.text }]);
      });
      setResult(r);
      setRuns(await listRuns(invoke, slug));
      setWork(await listWork(invoke));
      setUsing(r.using);
      setSteps(r.steps);
      setNote(
        r.tests.passed && !r.keep.keep
          ? { text: `Built and the tests pass, but ${r.keep.blocking.map((b) => CHECK_NAME[b] ?? b).join(', ')} failed. Cost: ${r.costText}. It can’t be kept, so Undo it below.`, bad: true }
          : r.tests.passed
          ? { text: `Done and the tests pass. Cost: ${r.costText}. Check it, then press Keep or Undo below.`, bad: false }
          : { text: `Built, but the tests still fail${r.tests.fixAttempts ? ` after ${r.tests.fixAttempts} fix attempt${r.tests.fixAttempts === 1 ? '' : 's'}` : ''}. Cost: ${r.costText}. It can’t be kept, so Undo it below.`, bad: true },
      );
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setRunning(false);
    }
  }

  async function act(label: string, job: () => Promise<{ text: string; learned: string[] }>) {
    if (!invoke) return;
    setBusy(true);
    setNote({ text: label, bad: false });
    setLearned([]);
    try {
      const { text, learned } = await job();
      setRuns(await listRuns(invoke, slug));
      setWork(await listWork(invoke));
      setNote({ text, bad: false });
      setLearned(learned);
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const checkPhone = () =>
    act('Reading replies from your phone…', async () => {
      const r = await pollPhone(invoke!);
      return { text: r.done.length ? r.done.join(' ') : 'No new replies from your phone.', learned: [] };
    });

  const decide = (r: BuildRun, keep: boolean) =>
    act(keep ? `Keeping ${r.feature}…` : `Undoing ${r.feature}…`, async () => {
      const d = await decideRun(invoke!, r.id, keep);
      return { text: d.phone ? `${d.note} ${d.phone}` : d.note, learned: d.learned };
    });
  const rate = (r: BuildRun, n: number) =>
    act(`Saving ${n}/5…`, async () => ({ text: `Rated ${r.feature} ${n}/5.`, learned: (await rateRun(invoke!, r.id, n)).learned }));

  async function onStop() {
    if (!invoke) return;
    try {
      await stopBuild(invoke);
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    }
  }

  if (projects === null && !note) {
    return (
      <section className="card">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="card build">
      {work.length > 0 && (
        <div className="needs-you" role="region" aria-label="Needs you">
          <h3>Needs you ({work.length})</h3>
          <ul>
            {work.map((w) => (
              <li key={w.id}>
                {w.title}
                <span className="muted"> · {w.issue ? `on your phone as issue #${w.issue}` : 'not on your phone'}</span>
              </li>
            ))}
          </ul>
          {work.some((w) => w.issue) && (
            <button type="button" disabled={busy || running} onClick={() => void checkPhone()}>
              Check phone replies now
            </button>
          )}
        </div>
      )}
      {projects && projects.length === 0 && (
        <p className="muted">No finished plans yet. Finish a project’s plan interview first, then set its code folder.</p>
      )}
      {projects && projects.length > 0 && (
        <div className="key-controls">
          <label htmlFor="build-project">Project</label>
          <select id="build-project" value={slug} disabled={running} onChange={(e) => setSlug(e.target.value)}>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
          <label htmlFor="build-feature">Feature</label>
          <select id="build-feature" value={feature} disabled={running} onChange={(e) => setFeature(e.target.value)}>
            {features.map((f) => (
              <option key={f.id} value={f.id}>
                {f.id} {f.name}
              </option>
            ))}
          </select>
          {running ? (
            <button type="button" onClick={() => void onStop()}>
              Stop
            </button>
          ) : (
            <button type="button" disabled={!slug || !feature} onClick={() => void onBuild()}>
              Build {feature} (costs up to {limit})
            </button>
          )}
        </div>
      )}
      {using && <p className="using-line">{using}</p>}
      {steps.length > 0 && (
        <ol className="step-list" aria-label="Steps" aria-live="polite">
          {steps.map((s, i) => (
            <li key={i} className={s.refused ? 'refused' : undefined}>
              {s.text}
              {s.refused && <span className="hint"> {s.refused}</span>}
            </li>
          ))}
        </ol>
      )}
      {running && <p className="muted">Building…</p>}
      {result && (
        <div className="review" role="region" aria-label="Build result">
          <h3>What changed</h3>
          <p>{result.summary || 'No summary.'}</p>
          <p className="muted">
            Built in {result.run.path} on branch {result.run.branch}. Your own copy wasn’t touched.
          </p>
          <h3>Tests</h3>
          <p>{result.tests.passed ? 'All tests pass.' : 'Tests fail.'}</p>
          {result.tests.output && (
            <details>
              <summary>Test output (end)</summary>
              <pre className="test-output">{result.tests.output}</pre>
            </details>
          )}
          <h3>Pictures</h3>
          <p className="muted">{result.picturesNote}</p>
          {result.pictures.length > 0 && (
            <div className="pictures">
              {result.pictures.map((p) => (
                <figure key={p.name} className={`picture ${p.name}`}>
                  <img src={p.dataUrl} alt={`${p.name === 'phone' ? 'Phone' : 'Desktop'} picture of the build`} />
                  <figcaption>{p.name === 'phone' ? 'Phone' : 'Desktop'}</figcaption>
                </figure>
              ))}
            </div>
          )}
          {result.checks.length > 0 && (
            <>
              <h3>Free checks</h3>
              <ul className="check-list">
                {result.checks.map((c) => (
                  <li key={c.name} className={c.passed ? 'ok' : c.advisory ? 'advice' : 'bad'}>
                    {CHECK_NAME[c.name] ?? c.name}: {c.passed ? 'passed' : c.advisory ? 'advice (doesn’t stop Keep)' : 'failed'}
                    {c.detail && !c.passed && <pre className="test-output">{c.detail}</pre>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.synced && <p className="muted">Data folder: {result.synced}</p>}
          {result.phone && <p className="muted">Phone: {result.phone}</p>}
        </div>
      )}
      {runs.length > 0 && (
        <div className="runs" role="region" aria-label="Builds">
          <h3>Builds</h3>
          <ul className="run-list">
            {runs.map((r) => (
              <li key={r.id} className={`run-row ${r.status}`}>
                <span className="run-name">
                  {r.feature} · {new Date(r.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
                  {!r.testsPassed ? 'tests fail' : keepable(r) ? 'tests and checks pass' : 'a check failed'} · {STATUS[r.status]}
                  {r.status === 'kept' && r.keptInto ? ` into ${r.keptInto}` : ''}
                </span>
                {r.status === 'built' && (
                  <span className="run-actions">
                    <button type="button" disabled={busy || running || !keepable(r)} onClick={() => void decide(r, true)} aria-label={`Keep ${r.feature}`}>
                      Keep
                    </button>
                    <button type="button" disabled={busy || running} onClick={() => void decide(r, false)} aria-label={`Undo ${r.feature}`}>
                      Undo
                    </button>
                  </span>
                )}
                {r.status !== 'undone' && (
                  <span className="rating" role="group" aria-label={`Rate ${r.feature} build ${r.id}`}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} type="button" disabled={busy} aria-pressed={r.rating === n} onClick={() => void rate(r, n)}>
                        {n}
                      </button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="muted">Keep merges the build into your copy on this computer (it never pushes). Undo removes the build’s copy.</p>
        </div>
      )}
      {note && (
        <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
      {learned.length > 0 && (
        <div className="learned" role="region" aria-label="What the app learned">
          <h3>What the app learned</h3>
          <ul>
            {learned.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="muted">Saved in habits.md. You can undo it in Settings → History.</p>
        </div>
      )}
    </section>
  );
}
