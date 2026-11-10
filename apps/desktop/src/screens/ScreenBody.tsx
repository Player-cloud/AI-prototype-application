import type { Invoke } from '../engine';
import type { ScreenId } from '../screens';
import { Settings } from './Settings';
import { Tools } from './Tools';

// Placeholders until each screen's build step lands (see the plan's build order).
const COMING: Record<Exclude<ScreenId, 'settings' | 'ledger'>, string> = {
  projects: 'The plan interview arrives in build step 7.',
  build: 'The build loop arrives in build step 8.',
};

export function ScreenBody({ id, invoke }: { id: ScreenId; invoke: Invoke | null }) {
  if (id === 'settings') return <Settings invoke={invoke} />;
  if (id === 'ledger') return <Tools invoke={invoke} />;
  return (
    <section className="card">
      <p>{COMING[id]}</p>
    </section>
  );
}
