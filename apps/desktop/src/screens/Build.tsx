import { useEffect, useState } from 'react';
import type { Invoke } from '../engine';
import { listProjects, openProject, type Feature, type ProjectRow } from '../projects';
import { getSettings } from '../settings';
import { startBuild, stopBuild, type BuildResult, type BuildStep, type MakeChannel } from '../build';

type Note = { text: string; bad: boolean } | null;

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
    return () => {
      live = false;
    };
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
      setUsing(r.using);
      setSteps(r.steps);
      setNote({ text: `Done. Cost: ${r.costText}. Keep or Undo comes in the next step of the plan.`, bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setRunning(false);
    }
  }

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
        </div>
      )}
      {note && (
        <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
    </section>
  );
}
