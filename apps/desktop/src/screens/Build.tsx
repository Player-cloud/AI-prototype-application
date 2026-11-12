import { useEffect, useRef, useState } from 'react';
import type { Invoke } from '../engine';
import { listProjects, openProject, projectMap, type Feature, type MapFeature, type ProjectRow } from '../projects';
import { getSettings } from '../settings';
import { CHECK_NAME, LEVEL_HEADING, LEVEL_ORDER, approvePackages, findingsAt, costSoFar, endedWords, endedEarly, compareWorkflows, decideAsk, decideRun, keepable, listAsks, listRuns, listWork, needsPackageOk, pollPhone, rateRun, startBuild, stopBuild, type BuildResult, type BuildRun, type AskRequest, type BuildStep, type LiveView, type MakeChannel, type WorkItem, type WorkflowRow } from '../build';

type Note = { text: string; bad: boolean } | null;

const STATUS: Record<BuildRun['status'], string> = { built: 'waiting for Keep or Undo', kept: 'kept', undone: 'undone', running: 'running', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };

/** How often the screen refreshes Builds and Needs you, to show what was done from the phone. */
const REFRESH_MS = 30_000;

/** A plain page doesn't update itself: it's reloaded as the build changes, at most this often. */
const RELOAD_MS = 3_000;

/** The live view's two sizes, shown smaller: the same sizes as the final pictures. */
const FRAMES = [
  { name: 'desktop', label: 'Desktop', width: 1280, height: 800, scale: 0.4 },
  { name: 'phone', label: 'Phone', width: 390, height: 844, scale: 0.4 },
] as const;

/** V2 A: the build's own page, live, at desktop and phone sizes. */
export function LivePanel({ view, reload }: { view: LiveView; reload: number }) {
  return (
    <div className="live" role="region" aria-label="Live view">
      <h3>Live view</h3>
      <p className="muted">{view.note}</p>
      {view.url && (
        <div className="live-frames">
          {FRAMES.map((f) => (
            <figure key={f.name} className={`live-frame ${f.name}`} style={{ width: f.width * f.scale, height: f.height * f.scale + 20 }}>
              <div className="live-window" style={{ width: f.width * f.scale, height: f.height * f.scale }}>
                <iframe
                  key={`${view.url}-${reload}`}
                  src={view.url!}
                  title={`${f.label} live view of the build`}
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  style={{ width: f.width, height: f.height, transform: `scale(${f.scale})` }}
                />
              </div>
              <figcaption>{f.label}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

/** "£0.80 ($1.01)" */
export function limitText(gbp: number, gbpPerUsd: number): string {
  return `£${gbp.toFixed(2)} ($${(gbp / gbpPerUsd).toFixed(2)})`;
}

/** Before a build: what this feature touched in earlier kept builds (the project map). */
export function FeatureMap({ entry }: { entry: MapFeature | undefined }) {
  if (!entry || entry.files.length === 0) return <p className="muted">New feature: no files yet.</p>;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return (
    <details className="feature-map">
      <summary>This feature touched before: {count(entry.files.length, 'file')}, {count(entry.tests.length, 'test')}</summary>
      {entry.note && <p className="muted">{entry.note}</p>}
      <ul aria-label="Files this feature touched before">
        {entry.files.map((f) => (
          <li key={f}>
            <code>{f}</code>
            {entry.tests.includes(f) ? ' (test)' : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Step 8c: pick a finished project and one feature, build it, and watch each step live. */
export function Build({ invoke, makeChannel }: { invoke: Invoke | null; makeChannel: MakeChannel | null }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [slug, setSlug] = useState('');
  const [features, setFeatures] = useState<Feature[]>([]);
  const [feature, setFeature] = useState('');
  const [limit, setLimit] = useState('');
  const [using, setUsing] = useState('');
  const [advice, setAdvice] = useState<string[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [steps, setSteps] = useState<BuildStep[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [runs, setRuns] = useState<BuildRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [gbpPerUsd, setGbpPerUsd] = useState(0.79);
  const [learned, setLearned] = useState<string[]>([]);
  const [work, setWork] = useState<WorkItem[]>([]);
  const [asks, setAsks] = useState<AskRequest[]>([]);
  const [liveView, setLiveView] = useState<LiveView | null>(null);
  const [reload, setReload] = useState(0);
  const [map, setMap] = useState<Record<string, MapFeature>>({});
  const lastReload = useRef(0);

  useEffect(() => {
    if (!invoke) return;
    let live = true;
    Promise.all([listProjects(invoke), getSettings(invoke)])
      .then(([rows, s]) => {
        if (!live) return;
        const done = rows.filter((r) => r.finished);
        setProjects(done);
        setLimit(limitText(s.runCapGbp ?? 0.8, s.gbpPerUsd));
        setGbpPerUsd(s.gbpPerUsd);
        if (done[0]) setSlug(done[0].slug);
      })
      .catch((err: Error) => live && setNote({ text: err.message, bad: true }));
    listWork(invoke)
      .then((w) => live && setWork(w))
      .catch((err: Error) => live && setNote({ text: err.message, bad: true }));
    listAsks(invoke).then((a) => live && setAsks(a), () => undefined);
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

  const runsKey = runs.map((r) => `${r.id}:${r.status}:${r.rating ?? ''}`).join(',');
  // The project map: refreshed with the builds (a Keep changes it). It's a hint, so a failure is quiet.
  useEffect(() => {
    if (!invoke || !slug) return;
    let live = true;
    projectMap(invoke, slug).then(
      (m) => live && setMap(m.features),
      () => live && setMap({}),
    );
    return () => {
      live = false;
    };
  }, [invoke, slug, runsKey]);

  // CI-4: the comparison follows the builds (new, kept, undone or rated). It's advice, so a failure is quiet.
  useEffect(() => {
    if (!invoke || !runsKey) return;
    let live = true;
    compareWorkflows(invoke).then(
      (w) => live && setWorkflows(w),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [invoke, runsKey]);

  // Replies from the phone are read in the background (about once a minute); keep the lists fresh.
  useEffect(() => {
    if (!invoke || !slug) return;
    const t = setInterval(() => {
      listWork(invoke).then(setWork, () => undefined);
      listAsks(invoke).then(setAsks, () => undefined);
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
    setAdvice([]);
    setSteps([]);
    setResult(null);
    setNote(null);
    setLiveView(null);
    let reloads = false;
    try {
      const r = await startBuild(invoke, makeChannel, slug, feature, (e) => {
        if (e.type === 'using') {
          setUsing(e.using);
          setAdvice(e.advice ?? []);
        }
        else if (e.type === 'live') {
          reloads = e.reloads;
          setLiveView({ url: e.url, note: e.note, reloads: e.reloads });
        } else {
          setSteps((s) => [...s, e.refused ? { text: e.text, refused: e.refused } : { text: e.text }]);
          // A plain page is reloaded as the build changes; Next.js and Vite update themselves.
          if (reloads && Date.now() - lastReload.current >= RELOAD_MS) {
            lastReload.current = Date.now();
            setReload((n) => n + 1);
          }
        }
      });
      setResult(r);
      setRuns(await listRuns(invoke, slug));
      setWork(await listWork(invoke));
      setAsks(await listAsks(invoke).catch(() => []));
      setUsing(r.using);
      setAdvice(r.advice ?? []);
      setSteps(r.steps);
      setNote(
        r.tests.passed && r.keep.blocking.length === 1 && r.keep.blocking[0] === 'dependencies'
          ? { text: `Built and the tests pass, but it added new packages that need your OK. Cost: ${r.costText}. Press Approve new packages below, then Keep, or Undo it.`, bad: true }
          : r.tests.passed && !r.keep.keep
          ? { text: `Built and the tests pass, but ${r.keep.blocking.map((b) => CHECK_NAME[b] ?? b).join(', ')} failed. Cost: ${r.costText}. It can’t be kept, so Undo it below.`, bad: true }
          : r.tests.passed
          ? { text: `Done and the tests pass. Cost: ${r.costText}. Check it, then press Keep or Undo below.`, bad: false }
          : { text: `Built, but the tests still fail${r.tests.fixAttempts ? ` after ${r.tests.fixAttempts} fix attempt${r.tests.fixAttempts === 1 ? '' : 's'}` : ''}. Cost: ${r.costText}. It can’t be kept, so Undo it below.`, bad: true },
      );
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
      // A build that failed or was stopped still left a record: show it.
      setRuns(await listRuns(invoke, slug).catch(() => runs));
    } finally {
      setRunning(false);
    }
  }

  /** Allow once or No for a command a build asked about. */
  async function answerAsk(a: AskRequest, allow: boolean) {
    if (!invoke) return;
    setBusy(true);
    try {
      const r = await decideAsk(invoke, a.id, allow);
      setAsks(await listAsks(invoke));
      setNote({ text: r.note, bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
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
  const approve = (r: BuildRun) =>
    act(`Approving the new packages for ${r.feature}…`, async () => ({ text: (await approvePackages(invoke!, r.id)).note, learned: [] }));
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
      {work.length + asks.length > 0 && (
        <div className="needs-you" role="region" aria-label="Needs you">
          <h3>Needs you ({work.length + asks.length})</h3>
          <ul>
            {asks.map((a) => (
              <li key={`ask-${a.id}`}>
                {a.slug} {a.feature} wants to run this, and a rule says to ask you first ({a.reason}):
                <pre className="ask-input">{a.input}</pre>
                <button type="button" disabled={busy || running} aria-label={`Allow once: ${a.input}`} onClick={() => void answerAsk(a, true)}>
                  Allow once
                </button>{' '}
                <button type="button" disabled={busy || running} aria-label={`No: ${a.input}`} onClick={() => void answerAsk(a, false)}>
                  No
                </button>
              </li>
            ))}
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
      {projects && projects.length > 0 && feature && <FeatureMap entry={map[feature]} />}
      {using && <p className="using-line">{using}</p>}
      {advice.length > 0 && (
        <ul className="advice" aria-label="What real builds say">
          {advice.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
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
      {running && liveView && <LivePanel view={liveView} reload={reload} />}
      {running && <p className="muted">Building…</p>}
      {result && (
        <div className="review" role="region" aria-label="Build result">
          <h3>What the model says it did</h3>
          <p className="muted">Its own words. Only the tests and checks below were checked by the app.</p>
          <blockquote className="model-says">{result.summary || 'No summary.'}</blockquote>
          {(result.claims ?? []).length > 0 && (
            <ul className="claim-list" aria-label="The model’s claims, checked by the app">
              {result.claims.map((c) => (
                <li key={c.topic} className={c.agrees === true ? 'ok' : c.agrees === false ? 'bad' : 'unchecked'}>
                  <span aria-hidden="true">{c.agrees === true ? '✓' : c.agrees === false ? '✗' : '?'} </span>
                  {c.topic}: {c.note}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            Built in {result.run.path} on branch {result.run.branch}. Your own copy wasn’t touched.
          </p>
          {result.questions && result.questions.length > 0 && (
            <div role="region" aria-label="The model’s questions">
              <h3>The model’s questions</h3>
              <p className="muted">It carried on with the safest choice. Answer from the build’s issue on your phone (“answer 1: …”); later builds of this project follow your answers.</p>
              <ol>
                {result.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ol>
            </div>
          )}
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
          {result.findings.length > 0 && (
            <>
              <h3>Free checks</h3>
              {LEVEL_ORDER.map((level) => {
                const at = findingsAt(result.findings, level);
                if (at.length === 0) return null;
                return (
                  <div key={level} className={`finding-group ${level}`} role="group" aria-label={LEVEL_HEADING[level]}>
                    <h4>{LEVEL_HEADING[level]} ({at.length})</h4>
                    <ul className="check-list">
                      {at.map((f, i) => (
                        <li key={`${f.check}-${i}`} className={level === 'pass' ? 'ok' : level === 'block' ? 'bad' : level === 'warn' ? 'advice' : 'note'}>
                          {f.title}
                          {f.file && <span className="muted"> ({f.file}{f.line ? `:${f.line}` : ''})</span>}
                          {f.detail && level !== 'pass' && <pre className="test-output">{f.detail}</pre>}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
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
                  {endedEarly(r) || r.status === 'running'
                    ? `${endedWords(r)} · cost so far ${costSoFar(r.costUsd, gbpPerUsd)}`
                    : `${!r.testsPassed ? 'tests fail' : keepable(r) ? 'tests and checks pass' : 'a check failed'} · ${STATUS[r.status]}`}
                  {r.status === 'kept' && r.keptInto ? ` into ${r.keptInto}` : ''}
                  {endedEarly(r) && r.error && r.status !== 'stopped' ? <span className="muted"> ({r.error})</span> : null}
                </span>
                {endedEarly(r) && !r.decidedAt && (
                  <span className="run-actions">
                    <button type="button" disabled={busy || running} onClick={() => void decide(r, false)} aria-label={`Clear the copy of ${r.feature} build ${r.id}`}>
                      Remove its copy
                    </button>
                  </span>
                )}
                {r.status === 'built' && (
                  <span className="run-actions">
                    {needsPackageOk(r) && (
                      <button type="button" disabled={busy || running} onClick={() => void approve(r)} aria-label={`Approve new packages for ${r.feature}`}>
                        Approve new packages
                      </button>
                    )}
                    <button type="button" disabled={busy || running || !keepable(r)} onClick={() => void decide(r, true)} aria-label={`Keep ${r.feature}`}>
                      Keep
                    </button>
                    <button type="button" disabled={busy || running} onClick={() => void decide(r, false)} aria-label={`Undo ${r.feature}`}>
                      Undo
                    </button>
                  </span>
                )}
                {(r.status === 'built' || r.status === 'kept') && (
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
      {workflows.length > 0 && (
        <div className="workflows" role="region" aria-label="Ways of building compared">
          <h3>Ways of building compared</h3>
          <ul>
            {workflows.map((w) => (
              <li key={w.model}>{w.text}</li>
            ))}
          </ul>
          <p className="muted">From real builds on this computer, all projects. The app only advises: the model for each job stays your choice.</p>
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
