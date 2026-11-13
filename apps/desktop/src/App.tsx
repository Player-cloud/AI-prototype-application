import { useEffect, useState } from 'react';
import { SCREENS, findScreen, type ScreenId } from './screens';
import { ScreenBody } from './screens/ScreenBody';
import { Build } from './screens/Build';
import { EngineBadge } from './EngineBadge';
import type { Invoke } from './engine';
import type { MakeChannel } from './build';
import { getSettings, saveSome } from './settings';

/** The screens Simple view keeps: the main journey, for demos and evaluators. */
export const SIMPLE_SCREENS: readonly ScreenId[] = ['projects', 'build', 'settings'];

export function App({ invoke = null, makeChannel = null }: { invoke?: Invoke | null; makeChannel?: MakeChannel | null }) {
  const [current, setCurrent] = useState<ScreenId>('projects');
  const [simple, setSimple] = useState(false);
  const [simpleNote, setSimpleNote] = useState('');
  const shown = SCREENS.filter((s) => !simple || SIMPLE_SCREENS.includes(s.id));

  useEffect(() => {
    if (!invoke) return;
    let live = true;
    getSettings(invoke).then(
      (s) => live && setSimple(s.simpleView === true),
      () => undefined, // the screens themselves say what's wrong with the settings
    );
    return () => {
      live = false;
    };
  }, [invoke]);

  // Build stays alive once opened, so a running build's live steps, Stop and report survive a visit
  // to another screen. It's only hidden, never unmounted.
  const [buildOpened, setBuildOpened] = useState(false);
  const screen = findScreen(current);
  const open = (id: ScreenId) => {
    setCurrent(id);
    if (id === 'build') setBuildOpened(true);
  };

  async function toggleSimple() {
    const next = !simple;
    setSimple(next);
    if (next && !SIMPLE_SCREENS.includes(current)) setCurrent('projects');
    if (!invoke) return;
    try {
      await saveSome(invoke, { simpleView: next });
      setSimpleNote('');
    } catch (err) {
      setSimpleNote((err as Error).message);
    }
  }

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">AI Prototype</div>
        {shown.map((s) => (
          <button
            key={s.id}
            type="button"
            className="rail-item"
            aria-current={s.id === current ? 'page' : undefined}
            onClick={() => open(s.id)}
          >
            {s.label}
          </button>
        ))}
        <EngineBadge invoke={invoke} />
        <label className="rail-switch">
          <input type="checkbox" checked={simple} onChange={() => void toggleSimple()} /> Simple view
        </label>
        {simpleNote && <p className="key-note bad">{simpleNote}</p>}
      </nav>
      <main className="panel">
        <h1>{screen.label}</h1>
        <p className="blurb">{screen.blurb}</p>
        {current !== 'build' && <ScreenBody id={current} invoke={invoke} makeChannel={makeChannel} />}
        {buildOpened && (
          <div hidden={current !== 'build'}>
            <Build invoke={invoke} makeChannel={makeChannel} />
          </div>
        )}
      </main>
    </div>
  );
}
