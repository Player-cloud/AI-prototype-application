// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Projects } from '../src/screens/Projects';
import type { Invoke } from '../src/engine';
import type { Interview, InterviewView, Patch, StageId } from '../src/projects';

afterEach(cleanup);

const STAGES = [
  { id: 'idea', title: 'The idea', intro: 'What you want to build.', questions: [{ id: 'what', text: 'What is it?', required: true }] },
  { id: 'features', title: 'Features', intro: 'Each feature gets a fixed ID.', questions: [] },
  { id: 'done', title: 'What “done” means', intro: 'Checks per feature.', questions: [] },
];
const ORDER: StageId[] = ['idea', 'features', 'done'];

/** A stand-in shell with a tiny in-memory version of the engine's interview rules. */
function fakeShell() {
  const projects = new Map<string, Interview>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];

  const missing = (iv: Interview, stage: StageId) => {
    if (stage === 'idea' && !iv.text['idea.what']) return ['Answer “What is it?”'];
    if (stage === 'features' && iv.features.length === 0) return ['Add at least one feature'];
    if (stage === 'done') return iv.features.filter((f) => !iv.done[f.id]?.length).map((f) => `Add at least one done check for ${f.id} ${f.name}`);
    return [];
  };
  const view = (iv: Interview, stage: StageId = iv.current): InterviewView => ({
    interview: structuredClone(iv),
    missing: missing(iv, stage),
    tools: stage === 'idea' ? [{ name: 'EGM', state: 'on', job: 'planning' }] : [],
    big: false,
    finished: ORDER.every((s) => iv.confirmed.includes(s)),
  });

  const invoke: Invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'project') throw `unexpected ${cmd}`;
    const method = String(args?.method);
    const p = (args?.params ?? {}) as Record<string, unknown>;
    calls.push({ method, params: p });
    const get = () => {
      const iv = projects.get(String(p.slug));
      if (!iv) throw `There’s no project called “${String(p.slug)}”.`;
      return iv;
    };
    switch (method) {
      case 'interview_stages':
        return { stages: STAGES, areas: [] } as T;
      case 'project_list':
        return [...projects.values()].map((iv) => ({ slug: iv.slug, name: iv.name, status: 'Planning', finished: false, updatedAt: '' })) as T;
      case 'interview_start': {
        const slug = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (projects.has(slug)) throw `There’s already a project called “${slug}”.`;
        const iv: Interview = { name: String(p.name), slug, current: 'idea', confirmed: [], text: {}, areas: [], features: [], done: {}, specAt: null, updatedAt: '' };
        projects.set(slug, iv);
        return view(iv) as T;
      }
      case 'interview_get':
        return view(get(), (p.stage as StageId) ?? undefined) as T;
      case 'interview_save': {
        const iv = get();
        const patch = p.patch as Patch;
        for (const [k, v] of Object.entries(patch.text ?? {})) if (v) iv.text[k] = v;
        if (patch.features) {
          let n = iv.features.length;
          iv.features = patch.features.filter((f) => f.name.trim()).map((f) => ({ id: f.id ?? `F-0${++n}`, name: f.name, what: f.what }));
        }
        if (patch.done) for (const [id, list] of Object.entries(patch.done)) iv.done[id] = list.filter(Boolean);
        return view(iv, p.stage as StageId) as T;
      }
      case 'interview_confirm': {
        const iv = get();
        const stage = p.stage as StageId;
        const gaps = missing(iv, stage);
        if (gaps.length) throw `Not ready yet: ${gaps.join('; ')}.`;
        iv.confirmed = ORDER.filter((s) => s === stage || iv.confirmed.includes(s));
        iv.current = ORDER.find((s) => !iv.confirmed.includes(s)) ?? 'done';
        const done = ORDER.every((s) => iv.confirmed.includes(s));
        return { view: view(iv), files: [], summary: done ? 'Spec written: 1 feature, each with a done file.' : 'Confirmed.' } as T;
      }
    }
    throw `unknown ${method}`;
  };
  return { invoke, calls, projects };
}

describe('Projects: plan interview', () => {
  it('says when there are no projects yet', async () => {
    render(<Projects invoke={fakeShell().invoke} />);
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });

  it('runs an interview stage by stage, with related tools first, and ends with a spec', async () => {
    const shell = fakeShell();
    render(<Projects invoke={shell.invoke} />);
    await screen.findByText(/No projects yet/);
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Club HR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start planning' }));

    // Stage 1: the related tools come before the questions.
    const form = await screen.findByRole('form', { name: 'The idea' });
    const tools = within(form).getByRole('list', { name: 'Related tools' });
    expect(tools.textContent).toContain('EGM: planning');
    expect(tools.compareDocumentPosition(within(form).getByLabelText('What is it?')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Can't move on until it's answered.
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm and continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not ready yet: Answer “What is it?”.');
    fireEvent.change(within(form).getByLabelText('What is it?'), { target: { value: 'HR for a sports club' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm and continue' }));

    // Stage 2: features.
    const features = await screen.findByRole('form', { name: 'Features' });
    fireEvent.change(within(features).getByLabelText('Feature 1 name'), { target: { value: 'Login' } });
    fireEvent.click(within(features).getByRole('button', { name: 'Confirm and continue' }));

    // Stage 3: done checks per feature.
    const done = await screen.findByRole('form', { name: 'What “done” means' });
    fireEvent.change(within(done).getByLabelText(/F-01 Login: done when/), { target: { value: 'A member can sign in\n' } });
    fireEvent.click(within(done).getByRole('button', { name: 'Confirm and continue' }));

    expect((await screen.findByRole('status')).textContent).toBe('Spec written: 1 feature, each with a done file.');
    expect(screen.getByText(/Spec ready in projects\/club-hr\/spec.md/)).toBeTruthy();
    expect(shell.projects.get('club-hr')?.done).toEqual({ 'F-01': ['A member can sign in'] });
    const stages = screen.getByRole('list', { name: 'Stages' });
    expect(within(stages).getAllByText(/✓/)).toHaveLength(3);
  });

  it('lets you go back to a confirmed stage, saving what you typed first', async () => {
    const shell = fakeShell();
    render(<Projects invoke={shell.invoke} />);
    await screen.findByText(/No projects yet/);
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Club HR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start planning' }));
    const form = await screen.findByRole('form', { name: 'The idea' });
    fireEvent.change(within(form).getByLabelText('What is it?'), { target: { value: 'HR' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm and continue' }));
    const features = await screen.findByRole('form', { name: 'Features' });
    fireEvent.change(within(features).getByLabelText('Feature 1 name'), { target: { value: 'Rota' } });

    fireEvent.click(screen.getByRole('button', { name: /✓ The idea/ }));
    expect(await screen.findByRole('form', { name: 'The idea' })).toBeTruthy();
    expect(shell.projects.get('club-hr')?.features.map((f) => f.name)).toEqual(['Rota']);
    expect(screen.getByRole('button', { name: 'Confirm again' })).toBeTruthy();
  });

  it('opens an existing project from the list and shows refusals in plain words', async () => {
    const shell = fakeShell();
    await shell.invoke('project', { method: 'interview_start', params: { name: 'Club HR' } });
    render(<Projects invoke={shell.invoke} />);
    const list = await screen.findByRole('list', { name: 'Projects' });
    fireEvent.click(within(list).getByRole('button', { name: /Club HR/ }));
    await screen.findByRole('form', { name: 'The idea' });
    fireEvent.click(screen.getByRole('button', { name: '← All projects' }));
    fireEvent.change(await screen.findByLabelText('Project name'), { target: { value: 'Club HR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start planning' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already a project/));
  });

  it('needs the desktop app', () => {
    render(<Projects invoke={null} />);
    expect(screen.getByText('Projects need the desktop app.')).toBeTruthy();
  });
});
