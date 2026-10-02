// a03: exceptions

class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
  describe() {
    return this.name + '[' + this.code + ']: ' + this.message;
  }
}

class ValidationError extends AppError {
  constructor(field, value) {
    super('invalid ' + field + '=' + JSON.stringify(value), 'E_VALID');
    this.name = 'ValidationError';
    this.field = field;
  }
}

class NotFoundError extends AppError {
  constructor(what) {
    super(what + ' not found', 404);
    this.name = 'NotFoundError';
  }
}

function returnInFinally() {
  try {
    return 'from try';
  } finally {
    // eslint-disable-next-line no-unsafe-finally
    return 'from finally';
  }
}

function finallyOverridesThrow() {
  try {
    throw new Error('lost');
  } finally {
    // eslint-disable-next-line no-unsafe-finally
    return 'finally swallowed error';
  }
}

function finallyRunsAfterReturn(log) {
  try {
    log.push('try');
    return log.length;
  } finally {
    log.push('finally');
  }
}

function catchReturnFinally() {
  let s = '';
  try {
    s += 't';
    throw 1;
  } catch (e) {
    s += 'c' + e;
    return s;
  } finally {
    s += 'f';
    console.log('  finally saw', s);
  }
}

function validate(user) {
  if (typeof user.name !== 'string') throw new ValidationError('name', user.name);
  if (!(user.age >= 0)) throw new ValidationError('age', user.age);
  return 'ok:' + user.name;
}

function lookup(db, id) {
  if (!(id in db)) throw new NotFoundError('user#' + id);
  return db[id];
}

function service(db, id) {
  try {
    const u = lookup(db, id);
    return validate(u);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return 'fallback for ' + id;
    }
    throw e; // rethrow
  }
}

function outerHandler(db, id) {
  try {
    return service(db, id);
  } catch (e) {
    return 'outer caught ' + e.describe() + ' field=' + e.field;
  }
}

function nestedRethrow() {
  const trace = [];
  try {
    try {
      try {
        throw new AppError('deep', 1);
      } catch (e) {
        trace.push('c1:' + e.code);
        e.code++;
        throw e;
      } finally {
        trace.push('f1');
      }
    } catch (e) {
      trace.push('c2:' + e.code);
      throw new AppError('wrapped(' + e.message + ')', e.code + 10);
    } finally {
      trace.push('f2');
    }
  } catch (e) {
    trace.push('c3:' + e.message + ':' + e.code);
  }
  console.log('trace', trace.join(' '));
}

function optionalCatchBinding() {
  let parsed;
  try {
    parsed = JSON.parse('{bad json');
  } catch {
    parsed = { fallback: true };
  }
  console.log('optional catch', JSON.stringify(parsed));
}

function finallyInLoops() {
  const log = [];
  for (let i = 0; i < 6; i++) {
    try {
      if (i === 1) continue;
      if (i === 4) break;
      log.push('body' + i);
    } finally {
      log.push('fin' + i);
    }
  }
  console.log('loop finally', log.join(','));
  const log2 = [];
  let k = 0;
  outer: while (k < 3) {
    k++;
    for (let j = 0; j < 3; j++) {
      try {
        if (j === 1) continue outer;
        log2.push(k + '.' + j);
      } finally {
        log2.push('F' + k + j);
      }
    }
  }
  console.log('labeled finally', log2.join(' '));
}

function errorProperties() {
  const e = new ValidationError('email', 'x@');
  console.log('name', e.name, 'msg', e.message);
  console.log('instanceof', e instanceof ValidationError, e instanceof AppError, e instanceof Error, e instanceof NotFoundError);
  console.log('toString', String(e));
  console.log('describe', e.describe());
  console.log('has stack', typeof e.stack === 'string');
  const plain = new Error('plain', { cause: e });
  console.log('cause', plain.cause === e, plain.cause.field);
}

function builtinErrors() {
  const tests = [
    () => null.prop,
    () => undefinedFn(),
    () => new Array(-1),
    () => (1).toFixed(200),
    () => decodeURIComponent('%'),
    () => {
      throw 'a string';
    },
    () => {
      throw { custom: 42 };
    },
    () => JSON.parse(''),
  ];
  tests.forEach((t, idx) => {
    try {
      t();
      console.log(idx, 'no throw');
    } catch (e) {
      if (e instanceof Error) console.log(idx, e.constructor.name);
      else console.log(idx, 'non-error', typeof e, JSON.stringify(e));
    }
  });
}

function errorInFinallyReplaces() {
  try {
    try {
      throw new Error('first');
    } finally {
      // eslint-disable-next-line no-unsafe-finally
      throw new Error('second');
    }
  } catch (e) {
    console.log('replaced by', e.message);
  }
}

function sumWithCleanup(arr) {
  let resource = 'open';
  let total = 0;
  try {
    for (const x of arr) {
      if (typeof x !== 'number') throw new TypeError('bad item ' + x);
      total += x;
    }
    return total;
  } catch (e) {
    return -1;
  } finally {
    resource = 'closed';
    console.log('  resource', resource, 'total', total);
  }
}

function aggregate() {
  const errs = [new Error('a'), new TypeError('b')];
  const ag = new AggregateError(errs, 'many');
  console.log('aggregate', ag.name, ag.message, ag.errors.length, ag.errors.map((x) => x.message).join(''));
}

console.log('returnInFinally', returnInFinally());
console.log('finallyOverridesThrow', finallyOverridesThrow());
const lg = [];
console.log('finallyRunsAfterReturn', finallyRunsAfterReturn(lg), lg.join('>'));
console.log('catchReturnFinally', catchReturnFinally());
const db = { 1: { name: 'ann', age: 30 }, 2: { name: 5, age: 1 }, 3: { name: 'bob', age: NaN } };
[1, 2, 3, 4].forEach((id) => console.log('handler', id, outerHandler(db, id)));
nestedRethrow();
optionalCatchBinding();
finallyInLoops();
errorProperties();
builtinErrors();
errorInFinallyReplaces();
console.log('sum', sumWithCleanup([1, 2, 3]));
console.log('sum', sumWithCleanup([1, 'x', 3]));
aggregate();
console.log('done a03');
