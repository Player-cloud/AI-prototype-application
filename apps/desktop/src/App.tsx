import { useState } from 'react';
import { SCREENS, findScreen, type ScreenId } from './screens';
import { ScreenBody } from './screens/ScreenBody';

export function App() {
  const [current, setCurrent] = useState<ScreenId>('projects');
  const screen = findScreen(current);

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
            onClick={() => setCurrent(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <main className="panel">
        <h1>{screen.label}</h1>
        <p className="blurb">{screen.blurb}</p>
        <ScreenBody id={current} />
      </main>
    </div>
  );
}
