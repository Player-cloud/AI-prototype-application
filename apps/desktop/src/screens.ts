export type ScreenId = 'projects' | 'build' | 'ledger' | 'centre' | 'settings';

export interface Screen {
  id: ScreenId;
  label: string;
  /** One plain sentence shown at the top of the screen. */
  blurb: string;
}

// Projects is the main screen (joshua's choice). Order here is the order in the rail.
export const SCREENS: readonly Screen[] = [
  { id: 'projects', label: 'Projects', blurb: 'Your apps and websites. Start a new one or pick one to keep building.' },
  { id: 'build', label: 'Build', blurb: 'What is being built right now: the Using line, the live steps, then the report.' },
  { id: 'ledger', label: 'Tools', blurb: 'Every tool, what it is for, how it did in trials, and its cost.' },
  { id: 'centre', label: 'Capability Centre', blurb: 'Every tool and model: where it is in its life, what its tests and real builds show, and what to do next. Only real records, never made-up numbers.' },
  { id: 'settings', label: 'Settings', blurb: 'Your API key, monthly budget and model choices.' },
];

export function findScreen(id: ScreenId): Screen {
  const screen = SCREENS.find((s) => s.id === id);
  if (!screen) throw new Error(`Unknown screen: ${id}`);
  return screen;
}
