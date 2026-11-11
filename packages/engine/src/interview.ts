/**
 * The plan interview (build step 7). Seven stages in a fixed order; each stage's questions come
 * in one go, with the tools that help with that stage listed first. A stage only counts once
 * joshua confirms it. The finished interview becomes projects/<slug>/spec.md, with an ID for
 * every feature and one pass/fail done file per feature (done/F-01.md, ...).
 *
 * This part is free: no model is called. Claude's help with planning comes in step 7b.
 */
import { createHash } from 'node:crypto';
import { isBigBuild } from '@aip/checks';
import type { AppSettings } from './settings.ts';

export type StageId = 'idea' | 'audience' | 'features' | 'checklist' | 'look' | 'tech' | 'done';

export interface Question {
  id: string;
  text: string;
  hint?: string;
  required?: boolean;
}

export interface Stage {
  id: StageId;
  title: string;
  /** What this stage settles, in one line. */
  intro: string;
  /** Plain text questions (features, checklist areas and done checks have their own inputs). */
  questions: Question[];
  /** Words matched against tool jobs, to list related tools first. */
  toolWords: string[];
}

export const STANDARD_STACK = 'Next.js + TypeScript, Postgres on Neon, Auth.js, shadcn/ui with Sonner, Vaul and cmdk';

/** Enterprise checklist areas a feature can touch. The first three make a build "big". */
export const CHECKLIST_AREAS = [
  'Logins and accounts',
  'Payments',
  'Personal data and privacy',
  'Security',
  'Accessibility',
  'Phone and desktop layout',
  'Speed',
  'Errors and empty states',
  'Backups and data export',
  'Admin and roles',
  'Emails and notifications',
  'Search engines (SEO)',
] as const;

export const STAGES: readonly Stage[] = [
  {
    id: 'idea',
    title: 'The idea',
    intro: 'What you want to build, in your own words.',
    questions: [
      { id: 'what', text: 'What is it, in a sentence or two?', required: true },
      { id: 'problem', text: 'What problem does it solve?' },
    ],
    toolWords: ['planning'],
  },
  {
    id: 'audience',
    title: 'Who it’s for and goals',
    intro: 'Who will use it and what success looks like.',
    questions: [
      { id: 'who', text: 'Who will use it?', required: true },
      { id: 'goals', text: 'What should they be able to do that they can’t now?', required: true },
      { id: 'measure', text: 'How will you know it’s working?' },
    ],
    toolWords: ['planning'],
  },
  {
    id: 'features',
    title: 'Features',
    intro: 'Each feature gets a fixed ID (F-01, F-02, …) and is built one at a time.',
    questions: [],
    toolWords: ['planning', 'plan'],
  },
  {
    id: 'checklist',
    title: 'Enterprise checklist',
    intro: 'Tick the areas this app touches. Free checks for these run after each feature, and the full checklist once at the end.',
    questions: [{ id: 'other', text: 'Anything else to watch out for?' }],
    toolWords: ['check', 'review', 'secret', 'audit', 'gatekeeper'],
  },
  {
    id: 'look',
    title: 'Look and brand',
    intro: 'How it should look and feel.',
    questions: [
      { id: 'feel', text: 'How should it look and feel?', hint: 'e.g. calm and simple, bold, playful', required: true },
      { id: 'brand', text: 'Colours, logo or brand to use?' },
      { id: 'likes', text: 'Any websites or apps you like the look of?' },
    ],
    toolWords: ['website ui', 'pictures', 'screenshot'],
  },
  {
    id: 'tech',
    title: 'Tech',
    intro: `The standard stack is ${STANDARD_STACK}. Only change it if this project needs something else.`,
    questions: [
      { id: 'stack', text: 'Use the standard stack?', hint: 'Leave empty to use it, or say what to use instead.' },
      { id: 'hosting', text: 'Anything about where it runs or what it connects to?' },
    ],
    toolWords: ['standard stack', 'package', 'template'],
  },
  {
    id: 'done',
    title: 'What “done” means',
    intro: 'For each feature, list the checks that must pass. Each line passes or fails.',
    questions: [{ id: 'overall', text: 'Anything else that must be true before the whole app is done?' }],
    toolWords: ['test', 'review'],
  },
];

export interface Feature {
  /** F-01, F-02, …; never reused or renumbered. */
  id: string;
  name: string;
  what: string;
}

export interface Interview {
  version: 1;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  /** The stage on screen now. */
  current: StageId;
  confirmed: StageId[];
  /** Answers keyed "stage.question", e.g. "idea.what". */
  text: Record<string, string>;
  areas: string[];
  features: Feature[];
  /** Done checks by feature ID. */
  done: Record<string, string[]>;
  /** Highest feature number ever handed out, so a removed ID is never reused. */
  lastFeature: number;
  /** When spec.md was last written. */
  specAt: string | null;
  /** The last plan review, and which spec it looked at. */
  review: PlanReview | null;
}

export interface PlanReview {
  at: string;
  /** Fingerprint of the spec that was reviewed; if the spec changed since, the review is out of date. */
  specHash: string;
  big: boolean;
  findings: { reviewer: string; severity: 'must' | 'should' | 'could'; text: string; feature?: string }[];
  costText: string;
}

function checkReview(v: unknown): PlanReview | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.at !== 'string' || typeof r.specHash !== 'string' || !Array.isArray(r.findings)) return null;
  const findings = (r.findings as unknown[]).flatMap((f) => {
    const ff = f as Record<string, unknown>;
    if (typeof ff?.text !== 'string' || !['must', 'should', 'could'].includes(ff.severity as string)) return [];
    const base = { reviewer: String(ff.reviewer ?? ''), severity: ff.severity as 'must' | 'should' | 'could', text: ff.text };
    return [typeof ff.feature === 'string' ? { ...base, feature: ff.feature } : base];
  });
  return { at: r.at, specHash: r.specHash, big: r.big === true, findings, costText: typeof r.costText === 'string' ? r.costText : '' };
}

export interface InterviewPatch {
  text?: Record<string, unknown>;
  areas?: unknown;
  features?: unknown;
  done?: unknown;
}

const MAX_TEXT = 2000;
const MAX_LINE = 200;
const MAX_FEATURES = 30;
const MAX_CHECKS = 20;
const STAGE_IDS = STAGES.map((s) => s.id);

export function stageOf(id: string): Stage {
  const s = STAGES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stage: ${id}`);
  return s;
}

function line(v: unknown, label: string, max = MAX_LINE): string {
  if (typeof v !== 'string') throw new Error(`${label} must be text`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > max) throw new Error(`${label} is too long (${max} characters at most)`);
  return t;
}

function block(v: unknown, label: string): string {
  if (typeof v !== 'string') throw new Error(`${label} must be text`);
  const t = v.replace(/\r\n/g, '\n').trim();
  if (t.length > MAX_TEXT) throw new Error(`${label} is too long (${MAX_TEXT} characters at most)`);
  return t;
}

export function newInterview(name: string, slug: string, now: Date): Interview {
  const at = now.toISOString();
  return {
    version: 1,
    name: line(name, 'Project name', 60),
    slug,
    createdAt: at,
    updatedAt: at,
    current: 'idea',
    confirmed: [],
    text: {},
    areas: [],
    features: [],
    done: {},
    lastFeature: 0,
    specAt: null,
    review: null,
  };
}

/** Checks an interview read from disk (it may have been edited by hand). */
export function checkInterview(raw: unknown): Interview {
  if (typeof raw !== 'object' || raw === null) throw new Error('interview.json is damaged');
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.slug !== 'string' || typeof r.name !== 'string') throw new Error('interview.json is damaged');
  const base = newInterview(r.name, r.slug, new Date(typeof r.createdAt === 'string' ? r.createdAt : 0));
  const iv: Interview = {
    ...base,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : base.createdAt,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : base.updatedAt,
    current: STAGE_IDS.includes(r.current as StageId) ? (r.current as StageId) : 'idea',
    confirmed: Array.isArray(r.confirmed) ? STAGE_IDS.filter((s) => (r.confirmed as unknown[]).includes(s)) : [],
    lastFeature: typeof r.lastFeature === 'number' && Number.isInteger(r.lastFeature) && r.lastFeature >= 0 ? r.lastFeature : 0,
    specAt: typeof r.specAt === 'string' ? r.specAt : null,
    review: checkReview(r.review),
  };
  return applyPatch(iv, { text: r.text as Record<string, unknown>, areas: r.areas, features: r.features, done: r.done }, true);
}

function featureNo(id: string): number {
  return Number(id.slice(2)) || 0;
}

function nextFeatureId(last: number, features: Feature[]): string {
  const max = features.reduce((m, f) => Math.max(m, featureNo(f.id)), last);
  return `F-${String(max + 1).padStart(2, '0')}`;
}

/** Applies new answers. Features keep their IDs; new ones get the next free ID. */
export function applyPatch(iv: Interview, patch: InterviewPatch, keepIds = false): Interview {
  const next: Interview = { ...iv, text: { ...iv.text }, done: { ...iv.done } };

  if (patch.text !== undefined && patch.text !== null) {
    if (typeof patch.text !== 'object') throw new Error('answers must be an object');
    for (const [key, value] of Object.entries(patch.text)) {
      const [stage = '', q = ''] = key.split('.');
      const question = stageOf(stage).questions.find((x) => x.id === q);
      if (!question) throw new Error(`unknown question: ${key}`);
      const t = block(value, question.text);
      if (t) next.text[key] = t;
      else delete next.text[key];
    }
  }

  if (patch.areas !== undefined && patch.areas !== null) {
    if (!Array.isArray(patch.areas)) throw new Error('areas must be a list');
    next.areas = CHECKLIST_AREAS.filter((a) => (patch.areas as unknown[]).includes(a));
  }

  if (patch.features !== undefined && patch.features !== null) {
    if (!Array.isArray(patch.features)) throw new Error('features must be a list');
    if (patch.features.length > MAX_FEATURES) throw new Error(`${MAX_FEATURES} features at most; split the rest into a later project`);
    const out: Feature[] = [];
    const known = new Set(iv.features.map((f) => f.id));
    for (const f of patch.features as unknown[]) {
      if (typeof f !== 'object' || f === null) throw new Error('each feature needs a name');
      const ff = f as Record<string, unknown>;
      const name = line(ff.name, 'Feature name', 80);
      if (!name) continue; // empty rows are ignored
      const what = block(ff.what ?? '', `What “${name}” does`);
      const given = typeof ff.id === 'string' ? ff.id : '';
      const ok = /^F-\d{2,3}$/.test(given) && (keepIds || known.has(given)) && !out.some((o) => o.id === given);
      // Numbering starts after the highest number ever used, so a removed ID is never handed out again.
      out.push({ id: ok ? given : nextFeatureId(iv.lastFeature, [...iv.features, ...out]), name, what });
    }
    next.features = out;
    next.lastFeature = [...iv.features, ...out].reduce((m, f) => Math.max(m, featureNo(f.id)), iv.lastFeature);
    // Done checks follow their feature; a removed feature's checks go with it.
    next.done = Object.fromEntries(Object.entries(next.done).filter(([id]) => out.some((f) => f.id === id)));
  }

  if (patch.done !== undefined && patch.done !== null) {
    if (typeof patch.done !== 'object' || Array.isArray(patch.done)) throw new Error('done checks must be by feature');
    for (const [id, checks] of Object.entries(patch.done as Record<string, unknown>)) {
      if (!next.features.some((f) => f.id === id)) throw new Error(`no feature ${id}`);
      const list = (Array.isArray(checks) ? checks : typeof checks === 'string' ? checks.split('\n') : [])
        .map((c) => line(c, `A done check for ${id}`))
        .filter(Boolean);
      if (list.length > MAX_CHECKS) throw new Error(`${MAX_CHECKS} done checks per feature at most`);
      next.done[id] = list;
    }
  }

  // A feature without done checks means "done" isn't settled any more.
  if (next.confirmed.includes('done') && next.features.some((f) => !(next.done[f.id]?.length))) {
    next.confirmed = next.confirmed.filter((s) => s !== 'done');
  }
  return next;
}

/** What's still missing before a stage can be confirmed, in plain words ([] = ready). */
export function missing(iv: Interview, stage: StageId): string[] {
  const s = stageOf(stage);
  const out = s.questions.filter((q) => q.required && !iv.text[`${stage}.${q.id}`]).map((q) => `Answer “${q.text}”`);
  if (stage === 'features' && iv.features.length === 0) out.push('Add at least one feature');
  if (stage === 'done') {
    if (iv.features.length === 0) out.push('Add features first');
    for (const f of iv.features) if (!(iv.done[f.id]?.length)) out.push(`Add at least one done check for ${f.id} ${f.name}`);
  }
  return out;
}

/** Big build: 5+ features, or logins, payments or personal data. Fresh-eyes review then applies. */
export function bigBuild(iv: Interview): boolean {
  return isBigBuild(iv.features.length, {
    logins: iv.areas.includes('Logins and accounts'),
    payments: iv.areas.includes('Payments'),
    personalData: iv.areas.includes('Personal data and privacy'),
  });
}

/** A fingerprint of the spec's content (the date it was written doesn't count). */
export function specHash(iv: Interview): string {
  const files = renderSpec(iv, new Date(0));
  return createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
}

/** Is there a review of the spec as it is now? */
export function reviewCurrent(iv: Interview): boolean {
  return iv.review !== null && iv.specAt !== null && iv.review.specHash === specHash(iv);
}

export function finished(iv: Interview): boolean {
  return STAGE_IDS.every((s) => iv.confirmed.includes(s));
}

/** Confirms a stage and moves to the next unconfirmed one. Throws with what's missing. */
export function confirmStage(iv: Interview, stage: StageId, now: Date): Interview {
  const gaps = missing(iv, stage);
  if (gaps.length) throw new Error(`Not ready yet: ${gaps.join('; ')}.`);
  const confirmed = STAGE_IDS.filter((s) => s === stage || iv.confirmed.includes(s));
  const current = STAGE_IDS.find((s) => !confirmed.includes(s)) ?? 'done';
  return { ...iv, confirmed, current, updatedAt: now.toISOString() };
}

function answer(iv: Interview, key: string, fallback = '—'): string {
  return iv.text[key] ?? fallback;
}

/** spec.md and one done file per feature, ready to save in projects/<slug>/. */
export function renderSpec(iv: Interview, now: Date): Record<string, string> {
  const day = now.toISOString().slice(0, 10);
  const big = bigBuild(iv);
  const stack = iv.text['tech.stack'] ? iv.text['tech.stack'] : `Standard stack: ${STANDARD_STACK}.`;
  const lines = [
    `# ${iv.name}: spec`,
    '',
    `Written by the plan interview on ${day}. Feature IDs never change. Each feature has a done file in done/; it is done only when every line there passes.`,
    '',
    '## The idea',
    '',
    answer(iv, 'idea.what'),
    '',
    `Problem it solves: ${answer(iv, 'idea.problem')}`,
    '',
    '## Who it’s for and goals',
    '',
    `- Who: ${answer(iv, 'audience.who')}`,
    `- Goals: ${answer(iv, 'audience.goals')}`,
    `- How we’ll know it works: ${answer(iv, 'audience.measure')}`,
    '',
    '## Features',
    '',
    ...iv.features.map((f) => `- **${f.id} ${f.name}**${f.what ? `: ${f.what.replace(/\n+/g, ' ')}` : ''} (done file: done/${f.id}.md)`),
    '',
    '## Enterprise checklist areas',
    '',
    ...(iv.areas.length ? iv.areas.map((a) => `- ${a}`) : ['- None ticked']),
    ...(iv.text['checklist.other'] ? ['', `Also watch: ${iv.text['checklist.other']}`] : []),
    '',
    '## Look and brand',
    '',
    `- Look and feel: ${answer(iv, 'look.feel')}`,
    `- Colours, logo, brand: ${answer(iv, 'look.brand')}`,
    `- Looks they like: ${answer(iv, 'look.likes')}`,
    '',
    '## Tech',
    '',
    `- Stack: ${stack}`,
    `- Where it runs and what it connects to: ${answer(iv, 'tech.hosting')}`,
    '',
    '## What “done” means',
    '',
    `- Every feature’s done file passes.`,
    ...(iv.text['done.overall'] ? [`- Also: ${iv.text['done.overall']}`] : []),
    `- Big build: ${big ? 'yes, so the plan gets a fresh-eyes review and paid reviews run' : 'no, so the free checks and one plan review are enough'}.`,
    '',
  ];
  const files: Record<string, string> = { 'spec.md': lines.join('\n') };
  for (const f of iv.features) {
    files[`done/${f.id}.md`] = [
      `# ${f.id} ${f.name}: done when`,
      '',
      'Each line passes or fails. The feature is done only when every line passes.',
      '',
      ...(iv.done[f.id] ?? []).map((c) => `- [ ] ${c}`),
      '',
    ].join('\n');
  }
  return files;
}

export interface ToolHint {
  name: string;
  state: string;
  job: string;
}

/** Tools whose job matches the stage, switched-off ones left out. */
export function toolsForStage(stage: StageId, tools: { name: string; state: string; job: string }[]): ToolHint[] {
  const words = stageOf(stage).toolWords;
  return tools
    .filter((t) => t.state !== 'off' && words.some((w) => `${t.job} ${t.name}`.toLowerCase().includes(w)))
    .map((t) => ({ name: t.name, state: t.state, job: t.job }));
}

/** Short status for the project list. */
export function projectStatus(iv: Interview): string {
  if (finished(iv)) return `Spec ready: ${iv.features.length} feature${iv.features.length === 1 ? '' : 's'}`;
  const n = STAGE_IDS.indexOf(iv.current) + 1;
  return `Planning: stage ${n} of ${STAGE_IDS.length} (${stageOf(iv.current).title})`;
}

export type { AppSettings };
