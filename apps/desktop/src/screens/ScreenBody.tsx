import type { Invoke } from '../engine';
import type { ScreenId } from '../screens';
import { Settings } from './Settings';

// Placeholders until each screen's build step lands (see the plan's build order).
const COMING: Record<Exclude<ScreenId, 'settings'>, string> = {
  projects: 'The plan interview arrives in build step 7.',
  build: 'The build loop arrives in build step 8.',
  ledger: 'The ledger and tool cards arrive in build step 5.',
};

export function ScreenBody({ id, invoke }: { id: ScreenId; invoke: Invoke | null }) {
  if (id === 'settings') return <Settings invoke={invoke} />;
  return (
    <section className="card">
      <p>{COMING[id]}</p>
    </section>
  );
}
