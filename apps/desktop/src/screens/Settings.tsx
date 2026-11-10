import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Invoke } from '../engine';
import { PROVIDERS, keyStatus, removeKey, saveKey, type Provider } from '../keys';

function KeyRow({ invoke, id, name, hint }: { invoke: Invoke; id: Provider; name: string; hint: string }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // Set once the user saves or removes, so a slow first status check can't overwrite the newer answer.
  const changed = useRef(false);

  useEffect(() => {
    let live = true;
    keyStatus(invoke, id)
      .then((s) => {
        if (live && !changed.current) setSaved(s.saved);
      })
      .catch((err: unknown) => {
        if (live) setNote({ text: String(err), bad: true });
      });
    return () => {
      live = false;
    };
  }, [invoke, id]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    changed.current = true;
    setBusy(true);
    try {
      const s = await saveKey(invoke, id, draft);
      setSaved(s.saved);
      setNote({ text: 'Saved in this computer’s password store.', bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
      await refresh(); // nothing changed; show the real state
    } finally {
      setDraft(''); // never keep the key on screen
      setBusy(false);
    }
  }

  async function onRemove() {
    changed.current = true;
    setBusy(true);
    try {
      const s = await removeKey(invoke, id);
      setSaved(s.saved);
      setNote({ text: 'Removed.', bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    try {
      setSaved((await keyStatus(invoke, id)).saved);
    } catch {
      // keep the error note already shown
    }
  }

  const inputId = `key-${id}`;
  return (
    <form className="key-row" onSubmit={onSave} aria-label={`${name} key`}>
      <div className="key-head">
        <label htmlFor={inputId}>{name}</label>
        <span className={saved ? 'key-saved' : 'key-missing'}>
          {saved === null ? 'Checking…' : saved ? 'Key saved' : 'No key'}
        </span>
      </div>
      <div className="key-controls">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={saved ? 'Paste a new key to replace it' : hint}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={busy || draft.trim() === ''}>
          Save
        </button>
        {saved && (
          <button type="button" onClick={onRemove} disabled={busy}>
            Remove
          </button>
        )}
      </div>
      {note && (
        <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
    </form>
  );
}

export function Settings({ invoke }: { invoke: Invoke | null }) {
  return (
    <section className="card settings">
      <h2>API keys</h2>
      <p className="muted">
        Keys are kept encrypted in this computer’s own password store (Credential Manager on Windows, the keyring on
        Linux). They are never saved in a file, sent to GitHub, or shown again. Each computer needs its own copy.
      </p>
      {invoke ? (
        PROVIDERS.map((p) => <KeyRow key={p.id} invoke={invoke} {...p} />)
      ) : (
        <p className="key-note bad">Keys can only be saved in the desktop app, not in a browser preview.</p>
      )}
      <h2>Budget and models</h2>
      <p className="muted">Monthly budget and model choices arrive in build step 4.</p>
    </section>
  );
}
