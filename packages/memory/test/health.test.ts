import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEEP_FAILURES,
  checkHealth,
  emptyHealth,
  healthNote,
  listHealth,
  noteVersion,
  readHealth,
  recordRun,
  causeWords,
  passedHealthCheck,
  setTrust,
  TRUST_LEVELS,
  type FailureCause,
  type ToolHealth,
  switchOff,
  switchOn,
  writeHealth,
} from '../src/index.js';

const T1 = new Date('2026-11-11T16:00:00Z');
const T2 = new Date('2026-11-11T16:05:00Z');

describe('tool health records', () => {
  it('takes the first version as the baseline, and a new one makes the evidence stale', () => {
    let h = noteVersion(emptyHealth('Only CLI (oc)'), '1.2.0');
    expect(h).toMatchObject({ version: '1.2.0', testedVersion: '1.2.0', stale: false, retestDue: false });
    expect(noteVersion(h, '1.2.0')).toBe(h);

    h = noteVersion(h, '1.3.0');
    expect(h).toMatchObject({ version: '1.3.0', testedVersion: '1.2.0', stale: true, retestDue: true });
    expect(healthNote(h)).toBe('Updated to 1.3.0 since it was tested. It gets a quick retest next time it’s used.');

    // Going back to the tested version needs no retest.
    expect(noteVersion(h, '1.2.0')).toMatchObject({ stale: false, retestDue: false });
  });

  it('a good retest clears the stale mark and the new version becomes the tested one', () => {
    let h = noteVersion(noteVersion(emptyHealth('oc'), '1.2.0'), '1.3.0');
    h = recordRun(h, { ok: false, error: 'timed out', cause: 'model' }, T1);
    expect(h).toMatchObject({ stale: true, retestDue: true, consecutiveFailures: 1, lastRetest: { at: T1.toISOString(), ok: false } });
    h = recordRun(h, { ok: true }, T2);
    expect(h).toMatchObject({ stale: false, retestDue: false, testedVersion: '1.3.0', consecutiveFailures: 0, lastOk: T2.toISOString(), lastRetest: { ok: true } });
    expect(healthNote(h)).toBe('');
  });

  it('counts failures in a row, keeps the newest, and never keeps key-shaped text', () => {
    let h = emptyHealth('oc');
    for (let i = 0; i < KEEP_FAILURES + 5; i++) h = recordRun(h, { ok: false, error: `  error\n${i}  `, cause: 'model' }, T1);
    expect(h.consecutiveFailures).toBe(KEEP_FAILURES + 5);
    expect(h.failures).toHaveLength(KEEP_FAILURES);
    expect(h.failures.at(-1)?.error).toBe(`error ${KEEP_FAILURES + 4}`);
    expect(healthNote(h)).toBe(`${KEEP_FAILURES + 5} failures in a row.`);

    // Obviously fake test value, not a real key.
    h = recordRun(h, { ok: false, error: 'bad key sk-ant-test-0000000000000000', cause: 'model' }, T1);
    expect(h.failures.at(-1)?.error).toBe('Failed (the message looked like it held a key, so it wasn’t kept).');
    expect(recordRun(h, { ok: true }, T2).consecutiveFailures).toBe(0);
  });

  it('switching off keeps the tool; switching on resets the count and retests', () => {
    let h = recordRun(emptyHealth('oc'), { ok: false, error: 'x', cause: 'model' }, T1);
    h = switchOff(h, '3 failures in a row.', T1);
    expect(healthNote(h)).toBe('Switched off: 3 failures in a row.');
    h = switchOn(h);
    expect(h).toMatchObject({ off: null, consecutiveFailures: 0, retestDue: true });
  });
});

describe('tool health files', () => {
  let folder = '';
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'aip-health-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('saves one file per tool in tool-health/ and reads it back', async () => {
    expect(await readHealth(folder, 'Only CLI (oc)')).toEqual(emptyHealth('Only CLI (oc)'));
    const h = recordRun(noteVersion(emptyHealth('Only CLI (oc)'), '1.2.0'), { ok: true }, T1);
    expect(await writeHealth(folder, h)).toBe('tool-health/only-cli-oc.json');
    expect(JSON.parse(await readFile(join(folder, 'tool-health', 'only-cli-oc.json'), 'utf8'))).toEqual(h);
    expect(await readHealth(folder, 'Only CLI (oc)')).toEqual(h);
    expect([...(await listHealth(folder)).keys()]).toEqual(['only-cli-oc']);
  });

  it('keys each record by the tool’s stable ID when given one (CI-1)', async () => {
    const h = recordRun(emptyHealth('Haiku 5.5', 'haiku'), { ok: true }, T1);
    expect(h.id).toBe('haiku');
    expect(await writeHealth(folder, h)).toBe('tool-health/haiku.json');
    expect(await readHealth(folder, 'Claude Haiku 5.5', 'haiku')).toEqual({ ...h, tool: 'Claude Haiku 5.5' }); // named as the caller names it
    expect((await listHealth(folder)).get('haiku')).toMatchObject({ id: 'haiku', tool: 'Haiku 5.5' });
    await expect(writeHealth(folder, emptyHealth('x', '../oops'))).rejects.toThrow('can’t be used as a tool ID');
  });

  it('reads a damaged or odd file as a clean record instead of failing', async () => {
    await mkdir(join(folder, 'tool-health'), { recursive: true });
    await writeFile(join(folder, 'tool-health', 'oc.json'), '{oops');
    expect(await readHealth(folder, 'oc')).toEqual(emptyHealth('oc'));
    await writeFile(join(folder, 'tool-health', 'oc.json'), '{"consecutiveFailures": -3, "failures": [1, {"at": "x", "error": "y"}], "stale": "yes"}');
    expect(await readHealth(folder, 'oc')).toMatchObject({ consecutiveFailures: 0, failures: [{ at: 'x', error: 'y' }], stale: false });
    await expect(writeHealth(folder, emptyHealth('!!!'))).rejects.toThrow('can’t be used as a tool ID');
  });
});

describe('versions per computer (CI-2)', () => {
  it('keeps each computer’s evidence its own, so the PC and laptop never mark each other stale', () => {
    let h = noteVersion(emptyHealth('axe-core'), '4.14.0', 'joshu');
    h = noteVersion(h, '4.15.0', 'lapto'); // the laptop's first sight is its own baseline
    expect(h.computers).toEqual({
      joshu: { version: '4.14.0', testedVersion: '4.14.0', stale: false, retestDue: false },
      lapto: { version: '4.15.0', testedVersion: '4.15.0', stale: false, retestDue: false },
    });
    expect(h.stale).toBe(false);
    h = noteVersion(h, '4.14.0', 'joshu'); // back on the PC: same as before, still fine
    expect(h).toMatchObject({ version: '4.14.0', stale: false, retestDue: false });

    // An update on the laptop only marks the laptop's evidence stale...
    h = noteVersion(h, '4.16.0', 'lapto');
    expect(h.computers.lapto).toMatchObject({ version: '4.16.0', testedVersion: '4.15.0', stale: true, retestDue: true });
    expect(h.computers.joshu!.stale).toBe(false);
    // ...and a good run there clears it.
    h = recordRun(h, { ok: true }, T1, 'lapto');
    expect(h.computers.lapto).toMatchObject({ testedVersion: '4.16.0', stale: false, retestDue: false });
    expect(h).toMatchObject({ stale: false, retestDue: false, lastRetest: { at: T1.toISOString(), ok: true } });
  });

  it('treats a record from before CI-2 as this computer’s, and keeps a retest asked for by Switch back on', () => {
    const old = noteVersion(emptyHealth('axe-core'), '4.0.0'); // no computers yet
    const h = noteVersion(old, '4.14.0', 'joshu');
    expect(h.computers.joshu).toMatchObject({ version: '4.14.0', testedVersion: '4.0.0', stale: true });
    const on = noteVersion(switchOn(noteVersion(emptyHealth('x'), '1', 'joshu')), '1', 'joshu');
    expect(on.retestDue).toBe(true);
  });
});

  describe('only the model’s or the tool’s own failures count (Q-3)', () => {
  const fail = (h: ReturnType<typeof emptyHealth>, cause: Parameters<typeof causeWords>[0]) => recordRun(h, { ok: false, error: `e ${cause}`, cause }, T1);

  it('3 cost-limit stops in a row never reach the count, but are recorded', () => {
    let h = emptyHealth('Sonnet 5.5', 'sonnet');
    for (let i = 0; i < 3; i++) h = fail(h, 'budget');
    expect(h.consecutiveFailures).toBe(0);
    expect(h.failures.map((f) => f.cause)).toEqual(['budget', 'budget', 'budget']);
    expect(healthNote(h)).toBe('Last failure not counted: the run hit its cost limit.');
  });

  it('3 model faults count', () => {
    let h = emptyHealth('Sonnet 5.5', 'sonnet');
    for (let i = 0; i < 3; i++) h = fail(h, 'model');
    expect(h.consecutiveFailures).toBe(3);
  });

  it('model, budget, model, model: the budget stop doesn’t reset the count, so the third model fault is the third', () => {
    let h = emptyHealth('Sonnet 5.5', 'sonnet');
    const counts: number[] = [];
    for (const c of ['model', 'budget', 'model', 'model'] as const) {
      h = fail(h, c);
      counts.push(h.consecutiveFailures);
    }
    expect(counts).toEqual([1, 1, 2, 3]);
  });

  it('a success still resets the count, and tool failures count', () => {
    let h = fail(fail(emptyHealth('oc'), 'tool'), 'tool');
    expect(h.consecutiveFailures).toBe(2);
    h = recordRun(h, { ok: true }, T2);
    expect(h.consecutiveFailures).toBe(0);
  });

  it('unknown causes are shown but don’t count', () => {
    const h = fail(emptyHealth('oc'), 'unknown');
    expect(h.consecutiveFailures).toBe(0);
    expect(healthNote(h)).toBe('Last failure not counted: the cause isn’t clear.');
  });

  it('old records without a cause read fine, as unknown', () => {
    const h = checkHealth(JSON.parse('{"consecutiveFailures": 2, "failures": [{"at": "x", "error": "y"}, {"at": "x", "error": "z", "cause": "nonsense"}]}'), 'oc');
    expect(h.consecutiveFailures).toBe(2);
    expect(h.failures.map((f) => f.cause)).toEqual(['unknown', 'unknown']);
  });
});

describe('trust levels', () => {
  const ok = (h: ToolHealth) => recordRun(h, { ok: true }, T1);
  const bad = (h: ToolHealth, cause: FailureCause = 'tool') => recordRun(h, { ok: false, error: 'x', cause }, T1);

  it('a new tool starts unknown, and an old record without trust reads as unknown', () => {
    expect(emptyHealth('oc').trust).toBe('unknown');
    expect(checkHealth({ consecutiveFailures: 0 }, 'oc').trust).toBe('unknown');
    expect(checkHealth({ trust: 'trusted' }, 'oc').trust).toBe('trusted');
    expect(checkHealth({ trust: 'super' }, 'oc').trust).toBe('unknown');
  });

  it('passing the health check moves unknown to checked, and nothing else does', () => {
    const fresh = emptyHealth('oc');
    // The health check: last use worked, no failures in a row, not switched off, evidence not out of date.
    expect(passedHealthCheck(fresh)).toBe(false);
    expect(bad(fresh).trust).toBe('unknown');
    expect(ok(fresh)).toMatchObject({ trust: 'checked', lastOk: T1.toISOString() });
    // Not while it is stale or waiting for a retest: that run is the retest, and it clears the mark first.
    const stale = noteVersion(noteVersion(fresh, '1.0.0'), '2.0.0');
    expect(passedHealthCheck(stale)).toBe(false);
    expect(ok(stale).trust).toBe('checked');
    // A failure after a success: the tool is no longer passing, but checked is not lowered by a score.
    expect(bad(ok(fresh)).trust).toBe('checked');
  });

  it('only joshua’s setTrust makes a tool trusted, and only from checked', () => {
    const checked = ok(emptyHealth('oc'));
    expect(setTrust(checked, 'trusted').trust).toBe('trusted');
    expect(() => setTrust(emptyHealth('oc'), 'trusted')).toThrow(/hasn’t passed its health check/);
    expect(() => setTrust(emptyHealth('oc'), 'checked')).toThrow();
    // Stop trusting.
    expect(setTrust(setTrust(checked, 'trusted'), 'checked').trust).toBe('checked');
    expect(setTrust(setTrust(checked, 'trusted'), 'unknown').trust).toBe('unknown');
    expect(() => setTrust(checked, 'nonsense' as never)).toThrow();
  });

  it('switching a trusted tool off drops it to checked, never lower; the others stay', () => {
    const trusted = setTrust(ok(emptyHealth('oc')), 'trusted');
    expect(switchOff(trusted, '3 failures in a row', T1).trust).toBe('checked');
    expect(switchOff(ok(emptyHealth('oc')), 'x', T1).trust).toBe('checked');
    expect(switchOff(emptyHealth('oc'), 'x', T1).trust).toBe('unknown');
    // Switching back on does not raise it either.
    expect(switchOn(switchOff(trusted, 'x', T1)).trust).toBe('checked');
  });

  it('nothing but a pass raises trust, and nothing but switch-off lowers it, whatever the run history', () => {
    // Every mix of failures (of every cause), stale versions and switch-on/off over 4 steps.
    const steps: ((h: ToolHealth) => ToolHealth)[] = [
      (h) => bad(h, 'tool'),
      (h) => bad(h, 'model'),
      (h) => bad(h, 'budget'),
      (h) => noteVersion(h, `v${h.version ? h.version + 1 : 1}`),
      (h) => switchOn(h),
    ];
    for (const start of TRUST_LEVELS) {
      const walk = (h: ToolHealth, depth: number) => {
        expect(h.trust).toBe(start);
        if (depth === 0) return;
        for (const s of steps) walk(s(h), depth - 1);
      };
      walk({ ...emptyHealth('oc'), trust: start, lastOk: start === 'unknown' ? null : T1.toISOString() }, 3);
    }
  });

  it('in code, only health.ts and joshua’s trust command can write trust; no score code can', async () => {
    // Trust is written in exactly two ways: by the app in health.ts (a pass in recordRun, switchOff) and
    // by joshua through setTrust, which only `setToolTrust` (the tool_trust command) calls.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const roots = ['memory', 'engine', 'tools', 'checks', 'models'].map((p) => join(__dirname, '../..', p, 'src'));
    const callers: string[] = [];
    const trustedLiterals: string[] = [];
    for (const dir of roots) {
      for (const f of await readdir(dir)) {
        if (!f.endsWith('.ts')) continue;
        const text = await readFile(join(dir, f), 'utf8');
        if (/\bsetTrust\(/.test(text)) callers.push(f);
        if (/trust:\s*'(trusted|checked)'/.test(text)) trustedLiterals.push(f);
      }
    }
    expect(callers.sort()).toEqual(['data.ts', 'health.ts']);
    // The only place a 'trusted' or 'checked' value is written into a record is health.ts.
    expect(trustedLiterals).toEqual(['health.ts']);
    // The score code (workflows, ratings, evals) never touches health trust.
    for (const f of ['workflows.ts', 'sync.ts', 'evals.ts', 'experiments.ts']) {
      expect(await readFile(join(__dirname, '../src', f), 'utf8')).not.toMatch(/\btrust\b/i);
    }
  });
});
