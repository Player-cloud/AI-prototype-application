import { useEffect, useState, type FormEvent } from 'react';
import type { Invoke } from '../engine';
import { STATE_LABEL, type ToolState } from '../data';
import {
  confirmStage,
  getStages,
  listProjects,
  openProject,
  saveAnswers,
  startProject,
  type InterviewView,
  type Patch,
  type ProjectRow,
  type Stage,
  type StageId,
} from '../projects';

type Note = { text: string; bad: boolean } | null;

function NoteLine({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
      {note.text}
    </p>
  );
}

/** The project list and the "new project" form. */
function ProjectList({ invoke, onOpen }: { invoke: Invoke; onOpen: (v: InterviewView) => void }) {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    listProjects(invoke)
      .then((r) => live && setRows(r))
      .catch((err: unknown) => live && setNote({ text: (err as Error).message, bad: true }));
    return () => {
      live = false;
    };
  }, [invoke]);

  async function run(job: () => Promise<InterviewView>) {
    setBusy(true);
    try {
      onOpen(await job());
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
      setBusy(false);
    }
  }

  function onStart(e: FormEvent) {
    e.preventDefault();
    void run(() => startProject(invoke, name.trim()));
  }

  return (
    <section className="card projects">
      <form className="key-controls" onSubmit={onStart} aria-label="New project">
        <input aria-label="Project name" placeholder="New project name, e.g. Club HR" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={busy || name.trim() === ''}>
          Start planning
        </button>
      </form>
      <NoteLine note={note} />
      {rows === null && !note && <p className="muted">Reading your projects…</p>}
      {rows?.length === 0 && <p className="hint">No projects yet. Name one above to start its plan interview.</p>}
      {rows && rows.length > 0 && (
        <ul className="project-list" aria-label="Projects">
          {rows.map((r) => (
            <li key={r.slug}>
              <button type="button" className="project-row" disabled={busy} onClick={() => void run(() => openProject(invoke, r.slug))}>
                <span className="tool-name">{r.name}</span>
                <span className={r.finished ? 'tool-state on' : 'tool-state trial'}>{r.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Draft {
  text: Record<string, string>;
  areas: string[];
  features: { id?: string; name: string; what: string }[];
  done: Record<string, string>;
}

function toDraft(v: InterviewView): Draft {
  const iv = v.interview;
  return {
    text: { ...iv.text },
    areas: [...iv.areas],
    features: iv.features.length ? iv.features.map((f) => ({ ...f })) : [{ name: '', what: '' }],
    done: Object.fromEntries(iv.features.map((f) => [f.id, (iv.done[f.id] ?? []).join('\n')])),
  };
}

/** Only the answers that belong to this stage are sent. */
function patchFor(stage: Stage, d: Draft): Patch {
  const text = Object.fromEntries(stage.questions.map((q) => [`${stage.id}.${q.id}`, d.text[`${stage.id}.${q.id}`] ?? '']));
  const patch: Patch = { text };
  if (stage.id === 'features') patch.features = d.features;
  if (stage.id === 'checklist') patch.areas = d.areas;
  if (stage.id === 'done') patch.done = Object.fromEntries(Object.entries(d.done).map(([id, t]) => [id, t.split('\n')]));
  return patch;
}

/** One project's plan interview, a stage at a time. */
function InterviewScreen({ invoke, start, onBack }: { invoke: Invoke; start: InterviewView; onBack: () => void }) {
  const [view, setView] = useState(start);
  const [stage, setStage] = useState<StageId>(start.interview.current);
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [areas, setAreas] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>(() => toDraft(start));
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getStages(invoke)
      .then((s) => {
        if (!live) return;
        setStages(s.stages);
        setAreas(s.areas);
      })
      .catch((err: unknown) => live && setNote({ text: (err as Error).message, bad: true }));
    return () => {
      live = false;
    };
  }, [invoke]);

  const iv = view.interview;
  const current = stages?.find((s) => s.id === stage);

  function show(v: InterviewView, at: StageId) {
    setView(v);
    setDraft(toDraft(v));
    setStage(at);
  }

  async function go(to: StageId) {
    if (!current) return;
    setBusy(true);
    try {
      await saveAnswers(invoke, iv.slug, current.id, patchFor(current, draft));
      show(await openProject(invoke, iv.slug, to), to);
      setNote(null);
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function onSave() {
    if (!current) return;
    setBusy(true);
    try {
      show(await saveAnswers(invoke, iv.slug, current.id, patchFor(current, draft)), current.id);
      setNote({ text: 'Saved.', bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    if (!current) return;
    setBusy(true);
    try {
      await saveAnswers(invoke, iv.slug, current.id, patchFor(current, draft));
      const r = await confirmStage(invoke, iv.slug, current.id);
      show(r.view, r.view.interview.current);
      setNote({ text: r.summary, bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const setText = (key: string, value: string) => setDraft({ ...draft, text: { ...draft.text, [key]: value } });
  const setFeature = (i: number, field: 'name' | 'what', value: string) =>
    setDraft({ ...draft, features: draft.features.map((f, j) => (j === i ? { ...f, [field]: value } : f)) });

  return (
    <section className="card interview">
      <div className="interview-head">
        <button type="button" className="link-button" onClick={onBack}>
          ← All projects
        </button>
        <h2>{iv.name}</h2>
        {view.finished && <p className="key-note">Spec ready in projects/{iv.slug}/spec.md{view.big ? ' · big build: the plan gets a fresh-eyes review' : ''}</p>}
      </div>
      {!stages && !note && <p className="muted">Loading…</p>}
      {stages && (
        <ol className="stage-list" aria-label="Stages">
          {stages.map((s, i) => {
            const done = iv.confirmed.includes(s.id);
            const open = done || s.id === iv.current;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className="stage-step"
                  aria-current={s.id === stage ? 'step' : undefined}
                  disabled={busy || !open || s.id === stage}
                  onClick={() => void go(s.id)}
                >
                  {done ? '✓' : `${i + 1}.`} {s.title}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {current && (
        <form className="budget-form" onSubmit={onConfirm} aria-label={current.title}>
          <h3>{current.title}</h3>
          <p className="muted">{current.intro}</p>
          {view.tools.length > 0 && (
            <div className="tool-hints">
              <p className="muted-inline">Tools that help here:</p>
              <ul className="rule-list" aria-label="Related tools">
                {view.tools.map((t) => (
                  <li key={t.name}>
                    <span className="rule-kind ask">{STATE_LABEL[t.state as ToolState] ?? t.state}</span> {t.name}: {t.job}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {current.id === 'features' && (
            <fieldset>
              <legend>Features</legend>
              {draft.features.map((f, i) => (
                <div className="field" key={f.id ?? `new-${i}`}>
                  <span className="feature-id">{f.id ?? 'new'}</span>
                  <input aria-label={`Feature ${i + 1} name`} placeholder="Name, e.g. Login" value={f.name} onChange={(e) => setFeature(i, 'name', e.target.value)} />
                  <input aria-label={`Feature ${i + 1} does`} placeholder="What it does" value={f.what} onChange={(e) => setFeature(i, 'what', e.target.value)} />
                  <button type="button" className="link-button" onClick={() => setDraft({ ...draft, features: draft.features.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                </div>
              ))}
              <div className="key-controls">
                <button type="button" onClick={() => setDraft({ ...draft, features: [...draft.features, { name: '', what: '' }] })}>
                  Add feature
                </button>
              </div>
            </fieldset>
          )}

          {current.id === 'checklist' && (
            <fieldset>
              <legend>Areas this app touches</legend>
              {areas.map((a) => (
                <label key={a} className="check">
                  <input
                    type="checkbox"
                    checked={draft.areas.includes(a)}
                    onChange={(e) => setDraft({ ...draft, areas: e.target.checked ? [...draft.areas, a] : draft.areas.filter((x) => x !== a) })}
                  />{' '}
                  {a}
                </label>
              ))}
            </fieldset>
          )}

          {current.id === 'done' &&
            iv.features.map((f) => (
              <div className="field column" key={f.id}>
                <label htmlFor={`done-${f.id}`}>
                  {f.id} {f.name}: done when… (one check per line)
                </label>
                <textarea
                  id={`done-${f.id}`}
                  rows={3}
                  value={draft.done[f.id] ?? ''}
                  onChange={(e) => setDraft({ ...draft, done: { ...draft.done, [f.id]: e.target.value } })}
                />
              </div>
            ))}

          {current.questions.map((q) => {
            const key = `${current.id}.${q.id}`;
            return (
              <div className="field column" key={key}>
                <label htmlFor={`q-${key}`}>
                  {q.text}
                  {q.required ? '' : ' (optional)'}
                </label>
                <textarea id={`q-${key}`} rows={2} placeholder={q.hint} value={draft.text[key] ?? ''} onChange={(e) => setText(key, e.target.value)} />
              </div>
            );
          })}

          {stage === iv.current && view.missing.length > 0 && <p className="hint">Still needed: {view.missing.join('; ')}.</p>}
          <div className="key-controls">
            <button type="button" disabled={busy} onClick={() => void onSave()}>
              Save
            </button>
            <button type="submit" disabled={busy}>
              {iv.confirmed.includes(current.id) ? 'Confirm again' : 'Confirm and continue'}
            </button>
          </div>
        </form>
      )}
      <NoteLine note={note} />
    </section>
  );
}

/** Projects: the list, then a project's plan interview. */
export function Projects({ invoke }: { invoke: Invoke | null }) {
  const [open, setOpen] = useState<InterviewView | null>(null);
  if (!invoke) return <section className="card"><p className="key-note bad">Projects need the desktop app.</p></section>;
  if (open) return <InterviewScreen key={open.interview.slug} invoke={invoke} start={open} onBack={() => setOpen(null)} />;
  return <ProjectList invoke={invoke} onOpen={setOpen} />;
}
