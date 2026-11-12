import { useEffect, useState } from 'react';
import type { Invoke } from '../engine';
import { getSettings, saveSome } from '../settings';

/**
 * Settings: let the app prepare dev-tool patch updates by itself (Q-5). Off by default. Turning it on
 * lets the app prepare them; it never merges one, never pushes, and joshua still presses Keep.
 */
export function Maintenance({ invoke, onSaved, reload = 0 }: { invoke: Invoke; onSaved?: () => void; reload?: number }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getSettings(invoke)
      .then((s) => live && setOn(s.maintenance?.patchUpdates === true))
      .catch((err: unknown) => live && setNote({ text: (err as Error).message, bad: true }));
    return () => {
      live = false;
    };
  }, [invoke, reload]);

  async function change(next: boolean) {
    setBusy(true);
    try {
      const saved = await saveSome(invoke, { maintenance: { patchUpdates: next } });
      setOn(saved.maintenance?.patchUpdates === true);
      setNote({ text: next ? 'On. Use “Prepare dev-tool patch updates now” on the Tools page. Nothing is kept without your OK.' : 'Off. The app won’t prepare any updates.', bad: false });
      onSaved?.();
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="maintenance">
      <label>
        <input type="checkbox" checked={on === true} disabled={busy || on === null} onChange={(e) => void change(e.target.checked)} /> Let the app prepare dev-tool patch updates
      </label>
      <p className="muted">
        Off unless you turn it on. When on, the app may try one small kind of update by itself: a dev tool (not a package your app ships with) moving to a newer patch version, like 1.2.3 to 1.2.5. Each
        one is tried in a separate copy of your project, installed without running any package’s own scripts, then your tests and the free checks run. If anything fails, the copy is thrown away and
        your code is untouched. If everything passes, it waits in Build for you to press Keep. It never merges or pushes by itself, and minor or major updates are always left to you. It costs nothing.
      </p>
      {note && (
        <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
