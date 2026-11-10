import type { ScreenId } from '../screens';

// Placeholders until each screen's build step lands (see the plan's build order).
const COMING: Record<ScreenId, string> = {
  projects: 'The plan interview arrives in build step 7.',
  build: 'The build loop arrives in build step 8.',
  ledger: 'The ledger and tool cards arrive in build step 5.',
  settings: 'The encrypted API key arrives next (step 3c).',
};

export function ScreenBody({ id }: { id: ScreenId }) {
  return (
    <section className="card">
      <p>{COMING[id]}</p>
    </section>
  );
}
