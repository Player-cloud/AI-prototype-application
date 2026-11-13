/**
 * V2 item D (part 2): the model's questions. A build never stops to wait for joshua: the model
 * carries on with the safest choice and lists what it had to guess at the end of its summary,
 * under "Questions for joshua:". They go in the build's issue. joshua answers from his phone
 * ("answer 1: …"), and each answer is kept in projects/<slug>/answers.md, which every later build
 * of that project reads first. Answers are his words about that project only; they never become
 * general habits or rules.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppSettings } from './settings.ts';

export const MAX_QUESTIONS = 5;
const MAX_LEN = 300;
export const ANSWERS_FILE = 'answers.md';

/** What the build prompt asks of the model. */
export const QUESTIONS_PROMPT =
  'If something the user should decide isn’t in the spec, don’t stop: choose the safest option and carry on. Then, at the very end of your summary, add a line “Questions for the user:” followed by one “- ” line per question (at most 5), each saying what you chose meanwhile.';

/** The questions at the end of a summary, or none. */
export function questionsIn(summary: string): string[] {
  const lines = summary.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*[#*_\s]*questions? for (?:the user|you|joshua)[*_\s]*:?[*_\s]*$/i.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(l);
    if (!m) {
      if (out.length && l.trim() === '') break;
      if (l.trim() === '') continue;
      break;
    }
    out.push(m[1]!.trim().slice(0, MAX_LEN));
    if (out.length === MAX_QUESTIONS) break;
  }
  return out;
}

/** "answer 2: use pounds" -> {n: 2, text}; "answer: …" is question 1. The rest of the reply counts too. */
export function parseAnswer(body: string): { n: number; text: string } | null {
  const m = /^\s*answer\s*(\d)?\s*[:\-–]\s*([\s\S]+)$/i.exec(body.trim());
  if (!m) return null;
  const text = m[2]!.replace(/\n*_Posted by AI Prototype\._\s*$/, '').trim();
  return text ? { n: m[1] ? Number(m[1]) : 1, text: text.slice(0, 2000) } : null;
}

/** joshua's earlier answers for a project, for the build prompt ('' when none). */
export async function answersFor(settings: AppSettings, slug: string): Promise<string> {
  if (!settings.dataFolder) return '';
  try {
    const text = (await readFile(join(settings.dataFolder, 'projects', slug, ANSWERS_FILE), 'utf8')).trim();
    return text ? `\n\nThe user’s answers to earlier questions on this project (follow them):\n${text}` : '';
  } catch {
    return '';
  }
}

/** Adds one answer to the project's answers.md and syncs. Returns plain words. */
export async function saveAnswer(settings: AppSettings, slug: string, feature: string, question: string, answer: string, now: Date): Promise<string> {
  if (!settings.dataFolder) throw new Error('Set the data folder in Settings first: answers are kept there.');
  const m = await import('@aip/memory');
  if (m.looksLikeKey(answer)) throw new Error('That answer looks like it has a key in it, so it wasn’t saved. Keys only go in the app’s Settings.');
  let before = '';
  try {
    before = await readFile(join(settings.dataFolder, 'projects', slug, ANSWERS_FILE), 'utf8');
  } catch {
    before = '# Your answers\n\nFrom build questions. Every later build of this project reads these first.\n';
  }
  const line = `- ${now.toISOString().slice(0, 10)}, ${feature}: ${question.replace(/\s+/g, ' ')} **Answer:** ${answer.replace(/\s+/g, ' ')}`;
  await m.writeProjectFiles(settings.dataFolder, slug, { [ANSWERS_FILE]: `${before.trimEnd()}\n${line}\n` });
  try {
    await m.syncDataRepo(settings.dataFolder, `Answer for ${slug} ${feature}`);
    return 'Saved for the next build of this project.';
  } catch (err) {
    return `Saved for the next build of this project (on this PC; not synced yet: ${(err as Error).message}).`;
  }
}

/** Shortens a summary to `max` characters without losing its questions at the end. */
export function shortenKeepingQuestions(summary: string, max: number): string {
  if (summary.length <= max) return summary;
  const qs = questionsIn(summary);
  if (!qs.length) return summary.slice(0, max);
  const tail = `\n\nQuestions for the user:\n${qs.map((q) => `- ${q}`).join('\n')}`;
  return `${summary.slice(0, Math.max(0, max - tail.length - 2)).trimEnd()} …${tail}`.slice(0, max);
}
