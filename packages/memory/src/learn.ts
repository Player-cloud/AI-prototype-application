/**
 * Step 9d: the app learns joshua's repeatable preferences from real evidence (his Keep or Undo,
 * his ratings, and what the checks keep finding), and writes them to habits.md. A habit is added
 * only with enough evidence, changed when the evidence changes, and dropped when it stops being
 * true. Only the app's own section of habits.md is touched; joshua's own lines are never changed.
 */
import type { Run } from './runlog.js';

export interface Learned {
  /** Stable id, so the same habit is updated rather than added twice. */
  id: string;
  text: string;
}

export interface HabitChanges {
  md: string;
  added: string[];
  changed: string[];
  dropped: string[];
}

/** Decided builds a model needs before the app says anything about it. */
export const MIN_BUILDS = 5;
/** Builds the same checklist finding must turn up in. */
export const MIN_REPEATS = 3;
export const HEADING = '## Learned by the app';
const NOTE = '_The app keeps this section up to date from your Keep, Undo and ratings. Your own lines above are never changed._';
const TAG = /\s*<!-- learned:([a-z0-9-]+) -->\s*$/;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** "file:line (Area): says" lines from a checklist check's detail. */
function checklistSays(run: Run): string[] {
  const c = run.checks.find((x) => x.name === 'checklist' && !x.passed);
  if (!c?.detail) return [];
  return [...new Set(c.detail.split('\n').map((l) => /\(([^)]+)\): (.+)$/.exec(l)).filter(Boolean).map((m) => `${m![1]}: ${m![2]}`))];
}

/** What the evidence says, newest builds first. `nameOf` gives a model's plain name. */
export function learnHabits(runs: Run[], nameOf: (model: string) => string): Learned[] {
  const out: Learned[] = [];

  // 1. Each build model: is it usually kept, or often undone?
  const decided = runs.filter((r) => r.status === 'kept' || r.status === 'undone');
  for (const model of [...new Set(decided.map((r) => r.model))]) {
    const mine = decided.filter((r) => r.model === model);
    if (mine.length < MIN_BUILDS) continue;
    const kept = mine.filter((r) => r.status === 'kept').length;
    const ratings = runs.filter((r) => r.model === model && r.rating !== null).map((r) => r.rating!);
    const rated = ratings.length >= 3 ? avg(ratings) : null;
    const facts = `kept ${kept} of ${mine.length}${rated === null ? '' : `, average rating ${rated.toFixed(1)}/5`}`;
    const name = nameOf(model);
    if (kept / mine.length >= 0.8 && (rated === null || rated >= 4)) {
      out.push({ id: `model-good-${slug(model)}`, text: `${name} builds are usually kept (${facts}): keep using it for builds.` });
    } else if (kept / mine.length <= 0.4 || (rated !== null && rated <= 2.5)) {
      out.push({ id: `model-weak-${slug(model)}`, text: `${name} builds are often undone or rated low (${facts}): try the strong model for builds.` });
    }
  }

  // 2. A checklist finding that keeps coming back: tell the build model up front.
  const recent = runs.slice(0, 10);
  const counts = new Map<string, number>();
  for (const r of recent) for (const s of checklistSays(r)) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const [says, n] of counts) {
    if (n >= MIN_REPEATS) out.push({ id: `checklist-${slug(says).slice(0, 40)}`, text: `Builds keep tripping the checklist rule “${says}” (${n} of the last ${recent.length} builds): build it right first time.` });
  }

  // 3. Fix attempts in most recent builds: run the tests before finishing.
  const last5 = runs.slice(0, 5);
  const fixed = last5.filter((r) => r.fixAttempts > 0).length;
  if (last5.length === 5 && fixed >= 3) {
    out.push({ id: 'fixes-often', text: `Recent builds often needed fix attempts (${fixed} of the last 5): run the tests and fix them before saying a build is done.` });
  }
  return out;
}

/** Puts the learned habits into habits.md's own section, and says what changed. */
export function applyLearned(habitsMd: string, learned: Learned[]): HabitChanges {
  const lines = habitsMd.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === HEADING);
  const own = start === -1 ? lines : lines.slice(0, start);
  const section = start === -1 ? [] : lines.slice(start + 1);
  const before = new Map<string, string>();
  for (const l of section) {
    const m = TAG.exec(l);
    if (m && l.startsWith('- ')) before.set(m[1]!, l.replace(TAG, '').slice(2).trim());
  }
  const added: string[] = [];
  const changed: string[] = [];
  for (const h of learned) {
    const old = before.get(h.id);
    if (old === undefined) added.push(h.text);
    else if (old !== h.text) changed.push(h.text);
  }
  const ids = new Set(learned.map((h) => h.id));
  const dropped = [...before].filter(([id]) => !ids.has(id)).map(([, text]) => text);
  if (!added.length && !changed.length && !dropped.length) return { md: habitsMd, added, changed, dropped };

  while (own.length && own[own.length - 1]!.trim() === '') own.pop();
  const body = learned.map((h) => `- ${h.text} <!-- learned:${h.id} -->`);
  const md = learned.length ? [...own, '', HEADING, '', NOTE, '', ...body, ''].join('\n') : [...own, ''].join('\n');
  return { md, added, changed, dropped };
}
