// a08: async/await & promises (deterministic microtask ordering)

const log = [];
function note(s) {
  log.push(s);
  console.log(s);
}

function delayValue(v, ticks) {
  // resolve after N microtask hops (deterministic, no timers)
  let p = Promise.resolve(v);
  for (let i = 0; i < ticks; i++) p = p.then((x) => x);
  return p;
}

function failAfter(msg, ticks) {
  return delayValue(null, ticks).then(() => {
    throw new Error(msg);
  });
}

async function ordering() {
  note('ordering: start');
  Promise.resolve().then(() => note('micro 1'));
  queueMicrotask(() => note('micro 2 (queueMicrotask)'));
  Promise.resolve()
    .then(() => note('micro 3a'))
    .then(() => note('micro 3b'));
  note('ordering: sync end');
  await null;
  note('after await null');
  await delayValue(0, 3);
  note('after chained awaits');
}

async function sequential() {
  const a = await delayValue('A', 2);
  const b = await delayValue('B', 1);
  const c = await delayValue(a + b, 0);
  note('sequential ' + a + b + c);
  return c.length;
}

async function combinators() {
  const all = await Promise.all([delayValue(1, 3), delayValue(2, 1), 3, delayValue(4, 0)]);
  note('all ' + JSON.stringify(all));
  const race = await Promise.race([delayValue('slow', 5), delayValue('fast', 1), delayValue('mid', 3)]);
  note('race ' + race);
  const settled = await Promise.allSettled([delayValue('ok', 1), failAfter('bad', 2), Promise.reject('raw')]);
  note('allSettled ' + settled.map((s) => s.status + ':' + (s.value || (s.reason && s.reason.message) || s.reason)).join(', '));
  const any = await Promise.any([failAfter('x', 1), delayValue('any-winner', 2), delayValue('later', 4)]);
  note('any ' + any);
  try {
    await Promise.any([failAfter('e1', 1), Promise.reject(new Error('e2'))]);
  } catch (e) {
    note('any all rejected: ' + e.constructor.name + ' ' + e.errors.map((x) => x.message).join('/'));
  }
  try {
    await Promise.all([delayValue(1, 1), failAfter('all-fail', 2), delayValue(3, 5)]);
  } catch (e) {
    note('all rejected: ' + e.message);
  }
}

async function errorHandling() {
  async function thrower(n) {
    if (n > 2) throw new RangeError('n too big: ' + n);
    return n * 2;
  }
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await thrower(i);
      note('thrower ' + i + ' -> ' + r);
    } catch (e) {
      note('thrower ' + i + ' caught ' + e.name + ': ' + e.message);
    } finally {
      if (i === 4) note('finally after last');
    }
  }
  const r = await thrower(10).catch((e) => 'recovered(' + e.message + ')');
  note(r);
  const chained = await Promise.reject(new Error('first'))
    .then(() => 'skipped')
    .catch((e) => {
      note('catch ' + e.message);
      return 'value-from-catch';
    })
    .finally(() => note('promise finally'))
    .then((v) => v + '!');
  note('chained ' + chained);
}

async function* asyncCounter(limit) {
  for (let i = 0; i < limit; i++) {
    await delayValue(null, 1);
    yield i * i;
  }
}

async function forAwait() {
  const out = [];
  for await (const v of asyncCounter(5)) out.push(v);
  note('for await gen ' + out.join(','));
  const mixed = [delayValue('p1', 2), 'plain', delayValue('p2', 0)];
  const out2 = [];
  for await (const v of mixed) out2.push(v);
  note('for await array ' + out2.join(','));
  const custom = {
    [Symbol.asyncIterator]() {
      let n = 3;
      return {
        next() {
          return Promise.resolve(n > 0 ? { value: 'c' + n--, done: false } : { done: true });
        },
      };
    },
  };
  const out3 = [];
  for await (const v of custom) out3.push(v);
  note('custom async iter ' + out3.join(','));
}

async function interleaving() {
  const trace = [];
  async function worker(name, steps) {
    for (let i = 0; i < steps; i++) {
      trace.push(name + i);
      await null;
    }
    return name;
  }
  const res = await Promise.all([worker('a', 3), worker('b', 2), worker('c', 4)]);
  note('interleave ' + trace.join(' ') + ' => ' + res.join(''));
}

function thenables() {
  const thenable = {
    then(resolve) {
      resolve('from thenable');
    },
  };
  return (async () => {
    const v = await thenable;
    note('await thenable: ' + v);
    const p = new Promise((resolve, reject) => {
      resolve('first-wins');
      reject(new Error('ignored'));
      resolve('ignored too');
    });
    note('promise settle once: ' + (await p));
    const nested = await Promise.resolve(Promise.resolve(Promise.resolve('deep')));
    note('flattened: ' + nested);
  })();
}

async function asyncClassMethod() {
  class Repo {
    constructor() {
      this.data = new Map([
        [1, 'one'],
        [2, 'two'],
      ]);
    }
    async get(id) {
      await null;
      if (!this.data.has(id)) throw new Error('missing ' + id);
      return this.data.get(id);
    }
    async getMany(ids) {
      return Promise.all(ids.map((id) => this.get(id).catch((e) => '<' + e.message + '>')));
    }
  }
  const r = new Repo();
  note('repo ' + (await r.getMany([2, 3, 1])).join(','));
  const arrow = async (x) => (await delayValue(x, 2)) + 1;
  note('async arrow ' + (await arrow(41)));
}

async function main() {
  await ordering();
  note('sequential returned ' + (await sequential()));
  await combinators();
  await errorHandling();
  await forAwait();
  await interleaving();
  await thenables();
  await asyncClassMethod();
  note('total notes ' + log.length);
}

console.log('script sync start');
main().then(() => console.log('done a08'));
console.log('script sync end');
