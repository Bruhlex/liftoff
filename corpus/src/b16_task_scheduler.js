// Promise-based task scheduler with priorities and retries using only microtasks
'use strict';

const PRIORITY = Object.freeze({ HIGH: 0, NORMAL: 1, LOW: 2 });
const LOG = [];

function log(msg) {
  LOG.push(msg);
  console.log(msg);
}

function tick(n = 1) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => undefined);
  return p;
}

class TaskError extends Error {
  constructor(message, { retryable = true, code = 'E_TASK' } = {}) {
    super(message);
    this.name = 'TaskError';
    this.retryable = retryable;
    this.code = code;
  }
}

class PriorityQueue {
  #items = [];
  #counter = 0;
  push(item, priority) {
    const entry = { item, priority, order: this.#counter++ };
    let i = this.#items.length;
    this.#items.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.#less(this.#items[i], this.#items[parent])) {
        [this.#items[i], this.#items[parent]] = [this.#items[parent], this.#items[i]];
        i = parent;
      } else break;
    }
  }
  pop() {
    const items = this.#items;
    if (!items.length) return undefined;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < items.length && this.#less(items[l], items[m])) m = l;
        if (r < items.length && this.#less(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top.item;
  }
  #less(a, b) {
    return a.priority < b.priority || (a.priority === b.priority && a.order < b.order);
  }
  get size() { return this.#items.length; }
}

class Task {
  static #nextId = 1;
  constructor(name, fn, { priority = PRIORITY.NORMAL, retries = 0, deps = [] } = {}) {
    this.id = Task.#nextId++;
    this.name = name;
    this.fn = fn;
    this.priority = priority;
    this.retries = retries;
    this.deps = deps;
    this.attempts = 0;
    this.state = 'pending';
    this.result = undefined;
    this.error = null;
  }
  get label() {
    return `${this.name}#${this.id}[p${this.priority}]`;
  }
}

class Scheduler {
  #queue = new PriorityQueue();
  #tasks = new Map();
  #running = 0;
  #listeners = { done: [], fail: [] };
  static created = 0;

  constructor({ concurrency = 2, backoffTicks = 1 } = {}) {
    this.concurrency = concurrency;
    this.backoffTicks = backoffTicks;
    this.stats = { started: 0, completed: 0, failed: 0, retried: 0 };
    Scheduler.created++;
  }

  on(event, fn) {
    this.#listeners[event]?.push(fn);
    return this;
  }

  #emit(event, ...args) {
    for (const fn of this.#listeners[event] ?? []) {
      try { fn(...args); } catch (e) { log(`listener error: ${e.message}`); }
    }
  }

  add(name, fn, opts) {
    const task = new Task(name, fn, opts);
    this.#tasks.set(name, task);
    return task;
  }

  #ready(task) {
    return task.deps.every((d) => this.#tasks.get(d)?.state === 'done');
  }

  #blocked(task) {
    return task.deps.some((d) => {
      const t = this.#tasks.get(d);
      return !t || t.state === 'failed' || t.state === 'skipped';
    });
  }

  async #runTask(task) {
    this.#running++;
    this.stats.started++;
    task.state = 'running';
    try {
      while (true) {
        task.attempts++;
        try {
          const depResults = task.deps.map((d) => this.#tasks.get(d).result);
          task.result = await task.fn({ attempt: task.attempts, deps: depResults, name: task.name });
          task.state = 'done';
          this.stats.completed++;
          log(`  ok   ${task.label} attempt ${task.attempts} -> ${JSON.stringify(task.result)}`);
          this.#emit('done', task);
          break;
        } catch (err) {
          const canRetry = (err.retryable ?? true) && task.attempts <= task.retries;
          log(`  fail ${task.label} attempt ${task.attempts}: ${err.message}${canRetry ? ' (retry)' : ''}`);
          if (!canRetry) {
            task.state = 'failed';
            task.error = err;
            this.stats.failed++;
            this.#emit('fail', task, err);
            break;
          }
          this.stats.retried++;
          await tick(this.backoffTicks * task.attempts);
        }
      }
    } finally {
      this.#running--;
    }
  }

  async run() {
    const pending = new Set(this.#tasks.values());
    const inflight = new Set();
    let round = 0;
    while (pending.size || inflight.size || this.#queue.size) {
      round++;
      for (const t of [...pending]) {
        if (this.#blocked(t)) {
          t.state = 'skipped';
          pending.delete(t);
          log(`  skip ${t.label} (dependency unavailable)`);
        } else if (this.#ready(t)) {
          this.#queue.push(t, t.priority);
          pending.delete(t);
        }
      }
      while (this.#running < this.concurrency && this.#queue.size) {
        const t = this.#queue.pop();
        const p = this.#runTask(t).then(() => inflight.delete(p));
        inflight.add(p);
      }
      if (!inflight.size && pending.size) {
        for (const t of pending) {
          t.state = 'skipped';
          log(`  skip ${t.label} (deadlock)`);
        }
        pending.clear();
        break;
      }
      if (inflight.size) await Promise.race(inflight);
      if (round > 1000) throw new Error('runaway scheduler');
    }
    return this.summary();
  }

  summary() {
    const byState = {};
    for (const { name, state } of this.#tasks.values()) (byState[state] ||= []).push(name);
    return byState;
  }
}

function flaky(failTimes, value, retryable = true) {
  return async ({ attempt }) => {
    await tick(2);
    if (attempt <= failTimes) throw new TaskError(`flaky failure ${attempt}/${failTimes}`, { retryable });
    return value;
  };
}

function compute(fn, ticks = 1) {
  return async (ctx) => {
    await tick(ticks);
    return fn(ctx);
  };
}

async function scenarioPriorities() {
  log('=== scenario: priorities ===');
  const s = new Scheduler({ concurrency: 1 });
  const order = [];
  const rec = (name) => compute(() => (order.push(name), name.length));
  s.add('low-a', rec('low-a'), { priority: PRIORITY.LOW });
  s.add('norm-a', rec('norm-a'));
  s.add('high-a', rec('high-a'), { priority: PRIORITY.HIGH });
  s.add('low-b', rec('low-b'), { priority: PRIORITY.LOW });
  s.add('high-b', rec('high-b'), { priority: PRIORITY.HIGH });
  const summary = await s.run();
  log(`order: ${order.join(' > ')}`);
  log(`summary: ${JSON.stringify(summary)} stats=${JSON.stringify(s.stats)}`);
}

async function scenarioRetries() {
  log('=== scenario: retries ===');
  const s = new Scheduler({ concurrency: 3, backoffTicks: 2 });
  const failures = [];
  s.on('fail', (t, e) => failures.push(`${t.name}:${e.code ?? e.name}`));
  s.on('done', (t) => { if (t.name === 'boom-listener') throw new Error('listener exploded'); });
  s.add('eventually', flaky(2, 'finally!'), { retries: 3 });
  s.add('never', flaky(10, 'x'), { retries: 2 });
  s.add('fatal', flaky(1, 'y', false), { retries: 5 });
  s.add('boom-listener', compute(() => 'fine'));
  s.add('thrower', () => { throw new TypeError('sync throw'); }, { retries: 1 });
  const summary = await s.run();
  log(`failures: ${failures.join(', ')}`);
  log(`summary: ${JSON.stringify(summary)} stats=${JSON.stringify(s.stats)}`);
}

async function scenarioDependencies() {
  log('=== scenario: dependencies ===');
  const s = new Scheduler({ concurrency: 2 });
  s.add('fetch-users', compute(() => [{ id: 1, name: 'ann' }, { id: 2, name: 'bob' }, { id: 3, name: 'cy' }], 3));
  s.add('fetch-orders', compute(() => [{ user: 1, amt: 30 }, { user: 3, amt: 12 }, { user: 1, amt: 8 }], 2));
  s.add('join', compute(({ deps: [users, orders] }) => {
    const totals = new Map(users.map(({ id, name }) => [id, { name, total: 0 }]));
    for (const { user, amt } of orders) totals.get(user).total += amt;
    return [...totals.values()].filter(({ total }) => total > 0);
  }), { deps: ['fetch-users', 'fetch-orders'], priority: PRIORITY.HIGH });
  s.add('report', compute(({ deps: [rows] }) => rows.map(({ name, total }) => `${name}=${total}`).join(';')), { deps: ['join'] });
  s.add('broken', flaky(5, null), { retries: 0 });
  s.add('after-broken', compute(() => 'never'), { deps: ['broken'] });
  s.add('missing-dep', compute(() => 'never'), { deps: ['ghost'] });
  s.add('cycle-a', compute(() => 1), { deps: ['cycle-b'] });
  s.add('cycle-b', compute(() => 2), { deps: ['cycle-a'] });
  const summary = await s.run();
  for (const k of Object.keys(summary).sort()) log(`  ${k}: ${summary[k].join(',')}`);
}

async function* taskStream(n) {
  for (let i = 1; i <= n; i++) {
    await tick();
    yield { name: `gen-${i}`, weight: (i * 7) % 5 };
  }
}

async function scenarioGenerated() {
  log('=== scenario: generated tasks ===');
  const s = new Scheduler({ concurrency: 4 });
  for await (const { name, weight } of taskStream(8)) {
    s.add(name, compute(({ attempt }) => weight * 10 + attempt, weight + 1), { priority: weight % 3 });
  }
  const summary = await s.run();
  log(`done count ${summary.done?.length ?? 0}, failed ${summary.failed?.length ?? 0}`);
}

function microtaskOrdering() {
  log('=== microtask ordering ===');
  const out = [];
  const p = Promise.resolve();
  p.then(() => out.push('a1')).then(() => out.push('a2')).then(() => out.push('a3'));
  p.then(() => out.push('b1')).then(() => out.push('b2'));
  (async () => {
    out.push('c0');
    await null;
    out.push('c1');
    await null;
    out.push('c2');
  })();
  queueMicrotask(() => out.push('q1'));
  out.push('sync');
  return tick(6).then(() => log(`order: ${out.join(' ')}`));
}

async function main() {
  await microtaskOrdering();
  await scenarioPriorities();
  await scenarioRetries();
  await scenarioDependencies();
  await scenarioGenerated();
  log(`schedulers created: ${Scheduler.created}, log lines: ${LOG.length}`);
}

main().catch((e) => console.log('fatal', e.message));
