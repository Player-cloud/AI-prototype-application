import { useEffect, useState, type ReactNode } from 'react';
import type { Invoke } from '../engine';
import { listRuns, revertRun, type BuildRun } from '../build';
import { getHistory, undoChange, type HistoryItem } from '../settings';

/** "11 Nov, 13:37" in this computer's time. */
export function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * The change history with one-click undo. `tick` changes whenever something else on the page
 * saves, so the list stays current. `onUndone` lets the page reload what an undo changed.
 */
export function History({ invoke, tick = 0, onUndone }: { invoke: Invoke; tick?: number; onUndone?: (kind: HistoryItem['kind']) => void }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState<BuildRun[]>([]);
  const [confirmRevert, setConfirmRevert] = useState<number | null>(null);

  /** The builds still kept, for their Undo. A problem reading them never hides the change list. */
  const keptBuilds = (invoke_: Invoke) =>
    listRuns(invoke_).then(
      (runs) => (Array.isArray(runs) ? runs.filter((r) => r.status === 'kept') : []),
      () => [] as BuildRun[],
    );

  useEffect(() => {
    let live = true;
    void keptBuilds(invoke).then((k) => live && setKept(k));
    getHistory(invoke)
      .then((h) => live && setItems(h))
      .catch((err: unknown) => live && setNote({ text: (err as Error).message, bad: true }));
    return () => {
      live = false;
    };
  }, [invoke, tick]);

  async function onUndo(item: HistoryItem) {
    setBusy(true);
    try {
      const r = await undoChange(invoke, item.id);
      setNote({ text: r.summary, bad: false });
      onUndone?.(r.kind);
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    }
    try {
      setItems(await getHistory(invoke));
    } catch {
      // keep the note already shown
    } finally {
      setBusy(false);
    }
  }

  async function onRevert(run: BuildRun) {
    setBusy(true);
    setConfirmRevert(null);
    try {
      const r = await revertRun(invoke, run.id);
      setNote({ text: r.note, bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    }
    try {
      setKept(await keptBuilds(invoke));
      setItems(await getHistory(invoke));
    } catch {
      // keep the note already shown
    } finally {
      setBusy(false);
    }
  }

  // Kept builds sit in the list by the time they were kept, newest first.
  const rows: { key: string; at: number; node: ReactNode }[] = [];
  for (const c of items ?? []) {
    rows.push({
      key: `c${c.id}`,
      at: Date.parse(c.at) || 0,
      node: (
        <>
          <span className="muted-inline">{when(c.at)}</span> {c.label}{' '}
          {c.undoneAt ? (
            <span className="muted-inline">(undone)</span>
          ) : c.kind === 'approval' || c.kind === 'revert' ? null : (
            <button type="button" className="link-button" disabled={busy} onClick={() => void onUndo(c)} aria-label={`Undo ${c.label}`}>
              Undo
            </button>
          )}
        </>
      ),
    });
  }
  for (const r of kept) {
    const at = r.decidedAt ?? r.at;
    rows.push({
      key: `k${r.id}`,
      at: Date.parse(at) || 0,
      node: (
        <>
          <span className="muted-inline">{when(at)}</span> Kept {r.feature}
          {r.keptInto ? ` into ${r.keptInto}` : ''}{' '}
          {confirmRevert === r.id ? (
            <>
              <span role="group" aria-label={`Confirm undoing ${r.feature} build ${r.id}`}>
                Are you sure? This adds a new commit that reverses it.
              </span>{' '}
              <button type="button" className="link-button" disabled={busy} onClick={() => void onRevert(r)} aria-label={`Yes, undo kept ${r.feature}`}>
                Yes
              </button>{' '}
              <button type="button" className="link-button" disabled={busy} onClick={() => setConfirmRevert(null)} aria-label={`No, keep ${r.feature}`}>
                No
              </button>
            </>
          ) : (
            <button type="button" className="link-button" disabled={busy} onClick={() => setConfirmRevert(r.id)} aria-label={`Undo this kept build ${r.feature} build ${r.id}`}>
              Undo this kept build
            </button>
          )}
        </>
      ),
    });
  }
  rows.sort((a, b) => b.at - a.at);

  return (
    <div className="history">
      {items === null && !note && <p className="muted">Loading…</p>}
      {items?.length === 0 && kept.length === 0 && <p className="hint">No changes yet. Settings changes and tool ratings show here, each with Undo.</p>}
      {rows.length > 0 && (
        <ul className="rule-list" aria-label="Changes">
          {rows.map((row) => (
            <li key={row.key}>{row.node}</li>
          ))}
        </ul>
      )}
      {note && (
        <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
