import type { Invoke } from '../engine';
import type { ScreenId } from '../screens';
import { Settings } from './Settings';
import { Tools } from './Tools';
import { Projects } from './Projects';
import { Build } from './Build';
import type { MakeChannel } from '../build';

export function ScreenBody({ id, invoke, makeChannel = null }: { id: ScreenId; invoke: Invoke | null; makeChannel?: MakeChannel | null }) {
  if (id === 'settings') return <Settings invoke={invoke} />;
  if (id === 'ledger') return <Tools invoke={invoke} />;
  if (id === 'projects') return <Projects invoke={invoke} />;
  return <Build invoke={invoke} makeChannel={makeChannel} />;
}
