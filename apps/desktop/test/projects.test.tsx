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
    askCost: 'costs up to £0.40 ($0.50)',
    reviewers: 1,
    reviewCost: 'costs up to £0.40 ($0.50)',
    reviewCurrent: iv.review !== null,
  });

  let settings = { dataFolder: '/data', codeFolders: {} as Record<string, string> };
  const invoke: Invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'interview_suggest') {
      calls.push({ method: 'suggest', params: args ?? {} });
      if (args?.stage === 'features') {
        return { suggestions: { questions: ['Do coaches log in too?'], areas: [], features: [{ name: 'Rota', what: 'Weekly shifts' }], done: {} }, modelName: 'Opus 5.5', costText: '£0.02 ($0.02)' } as T;
      }
      if (args?.stage === 'done') {
        return { suggestions: { questions: [], areas: [], features: [], done: { 'F-01': ['A wrong password shows an error'] } }, modelName: 'Opus 5.5', costText: '£0.03 ($0.04)' } as T;
      }
      throw 'No anthropic key saved. Add it in Settings.';
    }
    if (cmd === 'interview_review') {
      const iv = projects.get(String(args?.slug))!;
      iv.review = { at: '', big: false, costText: '£0.01 ($0.01)', findings: [{ reviewer: 'plan', severity: 'could', text: 'Dark mode' }, { reviewer: 'plan', severity: 'must', text: 'No password reset', feature: 'F-01' }] };
      return { view: view(iv), summary: '2 findings, 1 must fix. Cost: £0.01 ($0.01).' } as T;
    }
    if (cmd === 'settings_get') return structuredClone(settings) as T;
    if (cmd === 'settings_save') {
      settings = structuredClone(args?.settings) as typeof settings;
      for (const [k, v] of Object.entries(settings.codeFolders)) if (!v) delete settings.codeFolders[k];
      calls.push({ method: 'settings_save', params: args ?? {} });
      return structuredClone(settings) as T;
    }
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
        const iv: Interview = { name: String(p.name), slug, current: 'idea', confirmed: [], text: {}, areas: [], features: [], done: {}, specAt: null, updatedAt: '', review: null };
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
      case 'code_folder_check': {
        const folder = settings.codeFolders[String(p.slug)];
        if (!folder) throw 'Set this project’s code folder first: where its repo is cloned on this computer.';
        if (folder.includes('nope')) throw `${folder} isn’t a git repo. Clone the project’s repo there first.`;
        return { folder, branch: 'main', clean: false, runs: [{ path: `${folder}-runs/F-01-20261111-160509`, branch: 'aip/f-01-20261111-160509', feature: 'F-01' }] } as T;
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

    // The finished plan can be reviewed; findings show most serious first.
    const review = screen.getByRole('region', { name: 'Plan review' });
    fireEvent.click(within(review).getByRole('button', { name: 'Review the plan (costs up to £0.40 ($0.50))' }));
    const findings = await within(review).findByRole('list', { name: 'Findings' });
    expect([...findings.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Must fix F-01: No password reset', 'Could add Dark mode']);
    expect(screen.getByRole('status').textContent).toBe('2 findings, 1 must fix. Cost: £0.01 ($0.01).');
    expect(within(review).getByRole('button', { name: /Review again/ })).toBeTruthy();

    // Step 8a: the code folder for this computer, checked when saved.
    const code = screen.getByRole('region', { name: 'Code folder' });
    fireEvent.change(within(code).getByLabelText('Code folder path'), { target: { value: '/code/nope' } });
    fireEvent.click(within(code).getByRole('button', { name: 'Save' }));
    expect((await within(code).findByRole('alert')).textContent).toBe('/code/nope isn’t a git repo. Clone the project’s repo there first.');
    fireEvent.change(within(code).getByLabelText('Code folder path'), { target: { value: ' /code/club-hr ' } });
    fireEvent.click(within(code).getByRole('button', { name: 'Save' }));
    expect(await within(code).findByText('Ready: on branch main. Builds start from its last commit.')).toBeTruthy();
    expect(within(code).getByText(/changes that aren’t committed yet/)).toBeTruthy();
    expect(within(code).getByRole('list', { name: 'Feature runs' }).textContent).toBe('F-01: /code/club-hr-runs/F-01-20261111-160509');
    const saved = shell.calls.filter((c) => c.method === 'settings_save').at(-1)!.params.settings as { codeFolders: Record<string, string>; dataFolder: string };
    expect(saved.codeFolders).toEqual({ 'club-hr': '/code/club-hr' });
    expect(saved.dataFolder).toBe('/data');
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

  it('asks Claude for ideas only when you press the button, shows the cost and adds only what you pick', async () => {
    const shell = fakeShell();
    render(<Projects invoke={shell.invoke} />);
    await screen.findByText(/No projects yet/);
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Club HR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start planning' }));
    const idea = await screen.findByRole('form', { name: 'The idea' });
    expect(shell.calls.some((c) => c.method === 'suggest')).toBe(false);

    // No key: a plain-words refusal.
    fireEvent.click(within(idea).getByRole('button', { name: 'Ask Claude for ideas (costs up to £0.40 ($0.50))' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No anthropic key saved. Add it in Settings.');

    fireEvent.change(within(idea).getByLabelText('What is it?'), { target: { value: 'HR' } });
    fireEvent.click(within(idea).getByRole('button', { name: 'Confirm and continue' }));
    const features = await screen.findByRole('form', { name: 'Features' });
    fireEvent.change(within(features).getByLabelText('Feature 1 name'), { target: { value: 'Login' } });
    fireEvent.click(within(features).getByRole('button', { name: /Ask Claude for ideas/ }));
    const ideas = await screen.findByRole('region', { name: 'Claude’s ideas' });
    expect(within(ideas).getByText('Do coaches log in too?')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Opus 5.5 · cost £0.02 ($0.02)');
    // What was typed was saved before asking.
    expect(shell.projects.get('club-hr')?.features.map((f) => f.name)).toEqual(['Login']);

    fireEvent.click(within(ideas).getByRole('button', { name: 'Add Rota' }));
    expect((within(features).getByLabelText('Feature 2 name') as HTMLInputElement).value).toBe('Rota');
    expect(within(ideas).queryByRole('button', { name: 'Add Rota' })).toBeNull();
    fireEvent.click(within(features).getByRole('button', { name: 'Confirm and continue' }));

    const done = await screen.findByRole('form', { name: 'What “done” means' });
    expect(screen.queryByRole('region', { name: 'Claude’s ideas' })).toBeNull();
    fireEvent.change(within(done).getByLabelText(/F-01 Login: done when/), { target: { value: 'A member can sign in' } });
    fireEvent.click(within(done).getByRole('button', { name: /Ask Claude for ideas/ }));
    const doneIdeas = await screen.findByRole('region', { name: 'Claude’s ideas' });
    fireEvent.click(within(doneIdeas).getByRole('button', { name: 'Add “A wrong password shows an error” to F-01' }));
    expect((within(done).getByLabelText(/F-01 Login: done when/) as HTMLTextAreaElement).value).toBe('A member can sign in\nA wrong password shows an error');
  });

  it('needs the desktop app', () => {
    render(<Projects invoke={null} />);
    expect(screen.getByText('Projects need the desktop app.')).toBeTruthy();
  });
});
