/**
 * Step 7b: Claude helps with the plan interview. For the stage on screen it suggests follow-up
 * questions, checklist areas, features or done checks. Nothing is added until joshua picks it.
 * Uses the "plan" job (Opus for Claude), so each ask costs money; the call is capped like any other.
 */
import { CHECKLIST_AREAS, STAGES, stageOf, type Interview, type StageId } from './interview.ts';

export interface Suggestions {
  /** Things joshua might want to answer or think about. */
  questions: string[];
  /** Checklist areas that probably apply (checklist stage). */
  areas: string[];
  /** New features not already in the list (features stage). */
  features: { name: string; what: string }[];
  /** Done checks by feature ID (done stage). */
  done: Record<string, string[]>;
}

const MAX = { questions: 4, features: 8, checks: 4, line: 200 };

function answersSoFar(iv: Interview): string {
  const out: string[] = [];
  for (const s of STAGES) {
    for (const q of s.questions) {
      const a = iv.text[`${s.id}.${q.id}`];
      if (a) out.push(`- ${s.title} / ${q.text} ${a.replace(/\s+/g, ' ')}`);
    }
  }
  if (iv.features.length) out.push(`- Features: ${iv.features.map((f) => `${f.id} ${f.name}${f.what ? ` (${f.what})` : ''}`).join('; ')}`);
  if (iv.areas.length) out.push(`- Checklist areas: ${iv.areas.join(', ')}`);
  return out.join('\n') || '- (none yet)';
}

function task(iv: Interview, stage: StageId): string {
  switch (stage) {
    case 'features':
      return `Suggest up to ${MAX.features} features that are missing from the list, each small enough to build in one run, plus up to ${MAX.questions} questions. JSON: {"questions": ["..."], "features": [{"name": "...", "what": "..."}]}`;
    case 'checklist':
      return `Pick the areas that apply, only from this list: ${CHECKLIST_AREAS.join('; ')}. Add up to ${MAX.questions} questions. JSON: {"questions": ["..."], "areas": ["..."]}`;
    case 'done':
      return `For each feature (${iv.features.map((f) => f.id).join(', ') || 'none'}), write 2 to ${MAX.checks} checks that clearly pass or fail when tested. JSON: {"done": {"F-01": ["..."]}}`;
    default:
      return `Suggest up to ${MAX.questions} short follow-up questions that would make this stage clearer. JSON: {"questions": ["..."]}`;
  }
}

/** A short prompt: what's been said, the stage on screen, and the exact JSON to send back. */
export function suggestPrompt(iv: Interview, stage: StageId): string {
  const s = stageOf(stage);
  return [
    'You are helping plan a web app through a stage-by-stage interview. Use plain, short words.',
    `Project: ${iv.name}`,
    'Answers so far:',
    answersSoFar(iv),
    `Stage now: ${s.title}. ${s.intro}`,
    task(iv, stage),
    'Reply with the JSON only.',
  ].join('\n');
}

function lines(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/\s+/g, ' ').trim().slice(0, MAX.line))
    .filter(Boolean)
    .slice(0, max);
}

/** Reads the model's reply. Anything off-shape is dropped rather than trusted. */
export function parseSuggestions(text: string, iv: Interview, stage: StageId): Suggestions {
  const empty: Suggestions = { questions: [], areas: [], features: [], done: {} };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Claude’s reply wasn’t in the expected shape. Try again.');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('Claude’s reply wasn’t in the expected shape. Try again.');
  }
  const out = { ...empty, questions: lines(raw.questions, MAX.questions) };
  if (stage === 'checklist') {
    const picked = lines(raw.areas, CHECKLIST_AREAS.length);
    out.areas = CHECKLIST_AREAS.filter((a) => picked.includes(a) && !iv.areas.includes(a));
  }
  if (stage === 'features' && Array.isArray(raw.features)) {
    const have = new Set(iv.features.map((f) => f.name.toLowerCase()));
    for (const f of raw.features as unknown[]) {
      if (typeof f !== 'object' || f === null) continue;
      const ff = f as Record<string, unknown>;
      const [name] = lines([ff.name], 1);
      if (!name || have.has(name.toLowerCase())) continue;
      have.add(name.toLowerCase());
      out.features.push({ name: name.slice(0, 80), what: lines([ff.what], 1)[0] ?? '' });
      if (out.features.length >= MAX.features) break;
    }
  }
  if (stage === 'done' && typeof raw.done === 'object' && raw.done !== null) {
    for (const f of iv.features) {
      const checks = lines((raw.done as Record<string, unknown>)[f.id], MAX.checks).filter((c) => !(iv.done[f.id] ?? []).includes(c));
      if (checks.length) out.done[f.id] = checks;
    }
  }
  return out;
}
