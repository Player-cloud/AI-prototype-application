import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Invoke } from '../engine';
import { BudgetModels } from './BudgetModels';
import { SafetyRules } from './SafetyRules';
import { History } from './History';
import { PROVIDERS, keyStatus, removeKey, saveKey, setupPhone, testModel, type Provider } from '../keys';

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

  async function onTest() {
    setBusy(true);
    setNote({ text: 'Checking…', bad: false });
    try {
      setNote({ text: (await testModel(invoke, id)).summary, bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function onPhone() {
    setBusy(true);
    setNote({ text: 'Setting up…', bad: false });
    try {
      setNote({ text: (await setupPhone(invoke)).summary, bad: false });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
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
          <button type="button" onClick={onTest} disabled={busy}>
            Test connection
          </button>
        )}
        {saved && id === 'github' && (
          <button type="button" onClick={onPhone} disabled={busy}>
            Start builds from my phone
          </button>
        )}
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
  // `tick` refreshes the history after a save; `forms` reloads the forms after a settings undo.
  const [tick, setTick] = useState(0);
  const [forms, setForms] = useState(0);
  const saved = () => setTick((t) => t + 1);
  return (
    <section className="card settings">
      <h2>API keys</h2>
      <p className="muted">
        Keys are kept encrypted in this computer’s own password store (Credential Manager on Windows, the keyring on
        Linux). They are never saved in a file or shown again, and each one only goes to its own service. Each computer
        needs its own copy.
      </p>
      <p className="muted">
        The GitHub token lets the app message your phone through Issues on your data repo. Make a fine-grained token on
        GitHub (Settings → Developer settings → Fine-grained tokens) with only that repo and only “Issues: Read and
        write”.
      </p>
      {invoke ? (
        PROVIDERS.map((p) => <KeyRow key={p.id} invoke={invoke} {...p} />)
      ) : (
        <p className="key-note bad">Keys can only be saved in the desktop app, not in a browser preview.</p>
      )}
      <h2>Budget and models</h2>
      <p className="muted">Saved on this computer. No keys are kept here.</p>
      {invoke ? <BudgetModels reload={forms} invoke={invoke} onSaved={saved} /> : <p className="key-note bad">Budget and models can be changed in the desktop app only.</p>}
      <h2>Ask-first rules</h2>
      <p className="muted">Every risky step is checked against these first. The built-in ones can’t be changed here, and the agent can never change any of them.</p>
      {invoke ? <SafetyRules reload={forms} invoke={invoke} onSaved={saved} /> : <p className="key-note bad">Rules show in the desktop app only.</p>}
      <h2>Change history</h2>
      <p className="muted">Every settings change and tool rating is kept here. Undo puts it back, as long as nothing has changed it since.</p>
      {invoke ? (
        <History invoke={invoke} tick={tick} onUndone={(kind) => kind === 'settings' && setForms((f) => f + 1)} />
      ) : (
        <p className="key-note bad">History shows in the desktop app only.</p>
      )}
    </section>
  );
}
