import { useEffect, useState, type FormEvent } from 'react';
import type { Invoke } from '../engine';
import {
  dollarsFor,
  getSettings,
  getSpend,
  saveSome,
  spendLine,
  toNumber,
  type AppSettings,
  type EngineProvider,
  type Price,
  type SpendSummary,
} from '../settings';

const PROVIDER_CHOICES: readonly { id: EngineProvider; name: string }[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'deepseek', name: 'DeepSeek' },
];

type Other = 'openai' | 'deepseek';
const OTHERS: readonly { id: Other; name: string }[] = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'deepseek', name: 'DeepSeek' },
];

/** What the form holds: text, so a half-typed number isn't lost. */
interface Draft {
  provider: EngineProvider;
  budget: string;
  rate: string;
  models: Record<Other, { strong: string; everyday: string }>;
  prices: Record<string, { input: string; output: string }>;
  dataFolder: string;
}

function toDraft(s: AppSettings): Draft {
  return {
    provider: s.provider,
    budget: String(s.monthlyBudgetGbp),
    rate: String(s.gbpPerUsd),
    dataFolder: s.dataFolder,
    models: { openai: { ...s.models.openai }, deepseek: { ...s.models.deepseek } },
    prices: Object.fromEntries(
      Object.entries(s.prices).map(([m, p]) => [m, { input: String(p.inputPerM), output: String(p.outputPerM) }]),
    ),
  };
}

function fromDraft(d: Draft): Omit<AppSettings, 'extraRules'> {
  const prices: Record<string, Price> = {};
  for (const [model, p] of Object.entries(d.prices)) {
    if (p.input.trim() === '' && p.output.trim() === '') continue; // blank = price not known
    prices[model.trim()] = { inputPerM: toNumber(p.input), outputPerM: toNumber(p.output) };
  }
  return {
    provider: d.provider,
    monthlyBudgetGbp: toNumber(d.budget),
    gbpPerUsd: toNumber(d.rate),
    dataFolder: d.dataFolder.trim(),
    models: {
      openai: { strong: d.models.openai.strong.trim(), everyday: d.models.openai.everyday.trim() },
      deepseek: { strong: d.models.deepseek.strong.trim(), everyday: d.models.deepseek.everyday.trim() },
    },
    prices,
  };
}

/** The model names currently chosen for OpenAI and DeepSeek, once each. */
function chosenModels(d: Draft): string[] {
  const all = OTHERS.flatMap((o) => [d.models[o.id].strong.trim(), d.models[o.id].everyday.trim()]);
  return [...new Set(all.filter((m) => m !== ''))];
}

export function BudgetModels({ invoke }: { invoke: Invoke }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [spend, setSpend] = useState<SpendSummary | null>(null);

  useEffect(() => {
    let live = true;
    getSpend(invoke).then((s) => live && setSpend(s));
    getSettings(invoke)
      .then((s) => live && setDraft(toDraft(s)))
      .catch((err: unknown) => live && setNote({ text: (err as Error).message, bad: true }));
    return () => {
      live = false;
    };
  }, [invoke]);

  if (!draft) {
    return note ? (
      <p className="key-note bad" role="alert">
        {note.text}
      </p>
    ) : (
      <p className="muted">Loading…</p>
    );
  }

  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  const setModel = (o: Other, which: 'strong' | 'everyday', value: string) =>
    set({ models: { ...draft.models, [o]: { ...draft.models[o], [which]: value } } });
  const setPrice = (model: string, which: 'input' | 'output', value: string) =>
    set({ prices: { ...draft.prices, [model]: { input: '', output: '', ...draft.prices[model], [which]: value } } });

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await saveSome(invoke, fromDraft(draft));
      setDraft(toDraft(saved));
      setNote({ text: 'Saved on this computer.', bad: false });
      setSpend(await getSpend(invoke)); // the budget may have changed
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const rate = toNumber(draft.rate);
  return (
    <form className="budget-form" onSubmit={onSave} aria-label="Budget and models">
      <div className="field">
        <label htmlFor="provider">Provider for the app’s jobs</label>
        <select id="provider" value={draft.provider} onChange={(e) => set({ provider: e.target.value as EngineProvider })}>
          {PROVIDER_CHOICES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="budget">Monthly budget (£)</label>
        <input id="budget" inputMode="decimal" value={draft.budget} onChange={(e) => set({ budget: e.target.value })} />
        <span className="muted-inline">{dollarsFor(toNumber(draft.budget), rate)}</span>
      </div>
      {spend && <p className="spend-line" role="status">{spendLine(spend)}</p>}
      <p className="hint">Every model call’s cost is recorded on this computer. Calls stop once the month’s budget is used.</p>

      <div className="field">
        <label htmlFor="rate">£ per $1</label>
        <input id="rate" inputMode="decimal" value={draft.rate} onChange={(e) => set({ rate: e.target.value })} />
      </div>
      <p className="hint">Used to show every cost in £ and $. 0.79 is a starting guess; set today’s rate.</p>

      <div className="field">
        <label htmlFor="data-folder">Data folder</label>
        <input
          id="data-folder"
          spellCheck={false}
          placeholder="e.g. C:\Users\you\ai-prototype-data"
          value={draft.dataFolder}
          onChange={(e) => set({ dataFolder: e.target.value })}
        />
      </div>
      <p className="hint">Where your private ai-prototype-data repo is cloned. The Tools page reads it.</p>

      <h3>Models</h3>
      <p className="hint">Claude follows the fixed rule: Opus plans and reviews, Sonnet builds, Haiku reads and tests.</p>
      {OTHERS.map((o) => (
        <fieldset key={o.id}>
          <legend>{o.name}</legend>
          <div className="field">
            <label htmlFor={`${o.id}-strong`}>Strong model (plans, reviews)</label>
            <input id={`${o.id}-strong`} value={draft.models[o.id].strong} onChange={(e) => setModel(o.id, 'strong', e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${o.id}-everyday`}>Everyday model (everything else)</label>
            <input id={`${o.id}-everyday`} value={draft.models[o.id].everyday} onChange={(e) => setModel(o.id, 'everyday', e.target.value)} />
          </div>
        </fieldset>
      ))}
      <p className="hint">The starting names are guesses to check on each provider’s website.</p>

      <h3>Prices ($ per million tokens)</h3>
      <p className="hint">Copy these from each provider’s price page. Leave blank and costs show as “cost unknown”.</p>
      {chosenModels(draft).map((m) => (
        <div className="field price" key={m}>
          <span className="price-model">{m}</span>
          <input
            aria-label={`${m} input price`}
            placeholder="input"
            inputMode="decimal"
            value={draft.prices[m]?.input ?? ''}
            onChange={(e) => setPrice(m, 'input', e.target.value)}
          />
          <input
            aria-label={`${m} output price`}
            placeholder="output"
            inputMode="decimal"
            value={draft.prices[m]?.output ?? ''}
            onChange={(e) => setPrice(m, 'output', e.target.value)}
          />
        </div>
      ))}

      <div className="key-controls">
        <button type="submit" disabled={busy}>
          Save budget and models
        </button>
      </div>
      {note && (
        <p className={note.bad ? 'key-note bad' : 'key-note'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
    </form>
  );
}
