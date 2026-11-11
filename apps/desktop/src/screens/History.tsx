import { useEffect, useState } from 'react';
import type { Invoke } from '../engine';
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

  useEffect(() => {
    let live = true;
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

  return (
    <div className="history">
      {items === null && !note && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="hint">No changes yet. Settings changes and tool ratings show here, each with Undo.</p>}
      {items && items.length > 0 && (
        <ul className="rule-list" aria-label="Changes">
          {items.map((c) => (
            <li key={c.id}>
              <span className="muted-inline">{when(c.at)}</span> {c.label}{' '}
              {c.undoneAt ? (
                <span className="muted-inline">(undone)</span>
              ) : (
                <button type="button" className="link-button" disabled={busy} onClick={() => void onUndo(c)} aria-label={`Undo ${c.label}`}>
                  Undo
                </button>
              )}
            </li>
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
