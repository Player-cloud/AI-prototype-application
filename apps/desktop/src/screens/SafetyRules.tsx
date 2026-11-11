import { useEffect, useState, type FormEvent } from 'react';
import type { Invoke } from '../engine';
import { getRules, getSettings, saveSome, type RuleView } from '../settings';

const KIND: Record<RuleView['kind'], string> = { never: 'Never allowed', ask: 'Asks you first' };

/**
 * The ask-first rules. The built-in ones are shown but can't be changed here; joshua can add his
 * own, which the agent can never change.
 */
export function SafetyRules({ invoke, onSaved, reload = 0 }: { invoke: Invoke; onSaved?: () => void; reload?: number }) {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [match, setMatch] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getRules(invoke)
      .then((r) => live && setRules(r))
      .catch((err: unknown) => live && setNote({ text: (err as Error).message, bad: true }));
    return () => {
      live = false;
    };
  }, [invoke, reload]);

  async function change(edit: (current: { match: string; reason: string }[]) => { match: string; reason: string }[], done: string) {
    setBusy(true);
    try {
      const latest = await getSettings(invoke);
      await saveSome(invoke, { extraRules: edit(latest.extraRules) });
      setRules(await getRules(invoke));
      setNote({ text: done, bad: false });
      onSaved?.();
      return true;
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const rule = { match: match.trim(), reason: reason.trim() };
    if (await change((rs) => [...rs, rule], `Added. Anything mentioning “${rule.match}” now waits for your OK.`)) {
      setMatch('');
      setReason('');
    }
  }

  const yours = rules?.filter((r) => r.source === 'yours') ?? [];
  const builtIn = rules?.filter((r) => r.source !== 'yours') ?? [];
  return (
    <div className="rules">
      {rules === null && !note && <p className="muted">Loading…</p>}
      <ul className="rule-list" aria-label="Built-in rules">
        {builtIn.map((r) => (
          <li key={r.id}>
            <span className={`rule-kind ${r.kind}`}>{KIND[r.kind]}</span> {r.reason}
          </li>
        ))}
      </ul>
      <h3>Your own rules</h3>
      {yours.length === 0 ? (
        <p className="hint">None yet. Add words to watch for, like a service name, and the app will ask you first.</p>
      ) : (
        <ul className="rule-list" aria-label="Your rules">
          {yours.map((r, i) => (
            <li key={r.id}>
              <span className="rule-kind ask">{KIND.ask}</span> “{r.match}”: {r.reason}{' '}
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => void change((rs) => rs.filter((_, j) => j !== i), 'Removed.')}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="budget-form" onSubmit={onAdd} aria-label="Add a rule">
        <div className="field">
          <label htmlFor="rule-match">Words to watch for</label>
          <input id="rule-match" value={match} onChange={(e) => setMatch(e.target.value)} placeholder="e.g. stripe" />
        </div>
        <div className="field">
          <label htmlFor="rule-reason">Why</label>
          <input id="rule-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. payments need my OK" />
        </div>
        <div className="key-controls">
          <button type="submit" disabled={busy || match.trim() === '' || reason.trim() === ''}>
            Add rule
          </button>
        </div>
      </form>
      {note && (
        <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
