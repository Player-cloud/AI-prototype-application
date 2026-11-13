import { useState } from 'react';
import { SCREENS, findScreen, type ScreenId } from './screens';
import { ScreenBody } from './screens/ScreenBody';
import { Build } from './screens/Build';
import { EngineBadge } from './EngineBadge';
import type { Invoke } from './engine';
import type { MakeChannel } from './build';

export function App({ invoke = null, makeChannel = null }: { invoke?: Invoke | null; makeChannel?: MakeChannel | null }) {
  const [current, setCurrent] = useState<ScreenId>('projects');
  // Build stays alive once opened, so a running build's live steps, Stop and report survive a visit
  // to another screen. It's only hidden, never unmounted.
  const [buildOpened, setBuildOpened] = useState(false);
  const screen = findScreen(current);
  const open = (id: ScreenId) => {
    setCurrent(id);
    if (id === 'build') setBuildOpened(true);
  };

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">AI Prototype</div>
        {SCREENS.map((s) => (
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
