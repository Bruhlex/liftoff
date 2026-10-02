'use strict';
// CLI-style argument parser + command dispatcher operating on a sandbox temp dir.
// Features: shell-like tokenizer (quotes, escapes, $VARS), pipes, aliases, a typed
// option parser (-abc, --k=v, --no-x, repeatable, --), help text, and file commands.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Readable, Transform, pipeline } = require('stream');
const { promisify } = require('util');
const pipelineP = promisify(pipeline);

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- errors
class CliError extends Error {
  constructor(message, code = 1) { super(message); this.name = 'CliError'; this.code = code; }
}
class UsageError extends CliError {
  constructor(message) { super(message, 2); this.name = 'UsageError'; }
}
class NotFoundError extends CliError {
  constructor(p) { super('no such file or directory: ' + p, 3); this.name = 'NotFoundError'; }
}

// ---------------------------------------------------------------- tokenizer
function tokenize(line, env) {
  const tokens = [];
  let cur = '', had = false, i = 0;
  const push = () => { if (had) tokens.push({ type: 'word', value: cur }); cur = ''; had = false; };
  const expand = (src, j) => {
    const m = /^\$(\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*)|\?)/.exec(src.slice(j));
    if (!m) return [ '$', 1 ];
    const name = m[2] || m[4] || '?';
    const val = env[name] !== undefined ? String(env[name]) : (m[3] !== undefined ? m[3] : '');
    return [val, m[0].length];
  };
  outer: while (i < line.length) {
    const ch = line[i];
    switch (ch) {
      case ' ': case '\t': push(); i++; continue outer;
      case '|': push(); tokens.push({ type: 'pipe' }); i++; continue outer;
      case ';': push(); tokens.push({ type: 'semi' }); i++; continue outer;
      case '#': if (!had) break outer; cur += ch; i++; continue outer;
      case '\\': cur += line[i + 1] ?? ''; had = true; i += 2; continue outer;
      case "'": {
        const end = line.indexOf("'", i + 1);
        if (end < 0) throw new UsageError('unterminated single quote');
        cur += line.slice(i + 1, end); had = true; i = end + 1; continue outer;
      }
      case '"': {
        i++; had = true;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && '"\\$'.includes(line[i + 1])) { cur += line[i + 1]; i += 2; }
          else if (line[i] === '$') { const [v, n] = expand(line, i); cur += v; i += n; }
          else cur += line[i++];
        }
        if (line[i] !== '"') throw new UsageError('unterminated double quote');
        i++; continue outer;
      }
      case '$': { const [v, n] = expand(line, i); cur += v; had = true; i += n; continue outer; }
      default: cur += ch; had = true; i++;
    }
  }
  push();
  return tokens;
}

function splitPipelines(tokens) {
  const statements = [[[]]];
  for (const t of tokens) {
    const stmt = statements[statements.length - 1];
    if (t.type === 'semi') statements.push([[]]);
    else if (t.type === 'pipe') stmt.push([]);
    else stmt[stmt.length - 1].push(t.value);
  }
  return statements.map((s) => s.filter((c) => c.length)).filter((s) => s.length);
}

// ---------------------------------------------------------------- option parser
class OptionSpec {
  constructor(name, { alias, type = 'boolean', repeat = false, default: def, desc = '', choices } = {}) {
    Object.assign(this, { name, alias, type, repeat, def, desc, choices });
  }
  coerce(raw) {
    switch (this.type) {
      case 'number': {
        if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new UsageError(`--${this.name} expects a number, got "${raw}"`);
        return Number(raw);
      }
      case 'bigint': return BigInt(raw);
      case 'string':
        if (this.choices && !this.choices.includes(raw)) throw new UsageError(`--${this.name} must be one of ${this.choices.join('|')}`);
        return raw;
      default: return raw !== 'false';
    }
  }
}

class ArgParser {
  #specs = new Map();
  #aliases = new Map();
  constructor(command, positionals = []) { this.command = command; this.positionals = positionals; }
  option(name, cfg) {
    const s = new OptionSpec(name, cfg);
    this.#specs.set(name, s);
    if (s.alias) this.#aliases.set(s.alias, name);
    return this;
  }
  parse(argv) {
    const opts = {}, pos = [];
    for (const s of this.#specs.values()) opts[s.name] = s.repeat ? [] : s.def !== undefined ? s.def : s.type === 'boolean' ? false : undefined;
    const assign = (spec, raw) => {
      const v = spec.coerce(raw);
      if (spec.repeat) opts[spec.name].push(v); else opts[spec.name] = v;
    };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
      let m;
      if ((m = /^--no-([\w-]+)$/.exec(a))) {
        const spec = this.#specs.get(m[1]);
        if (!spec || spec.type !== 'boolean') throw new UsageError('unknown option --no-' + m[1]);
        opts[spec.name] = false;
      } else if ((m = /^--([\w-]+)(?:=(.*))?$/.exec(a))) {
        const spec = this.#specs.get(m[1]);
        if (!spec) throw new UsageError('unknown option --' + m[1]);
        if (spec.type === 'boolean') assign(spec, m[2] ?? 'true');
        else {
          const raw = m[2] ?? argv[++i];
          if (raw === undefined) throw new UsageError(`--${spec.name} requires a value`);
          assign(spec, raw);
        }
      } else if (/^-[A-Za-z]+$/.test(a)) {
        const letters = a.slice(1);
        for (let k = 0; k < letters.length; k++) {
          const name = this.#aliases.get(letters[k]);
          const spec = name && this.#specs.get(name);
          if (!spec) throw new UsageError(`unknown flag -${letters[k]}`);
          if (spec.type === 'boolean') { assign(spec, 'true'); continue; }
          const rest = letters.slice(k + 1);
          const raw = rest.length ? rest : argv[++i];
          if (raw === undefined) throw new UsageError(`-${letters[k]} requires a value`);
          assign(spec, raw);
          break;
        }
      } else pos.push(a);
    }
    if (opts.help) return { opts, args: pos };
    const req = this.positionals.filter((p) => !p.endsWith('?') && !p.endsWith('...'));
    if (pos.length < req.length) throw new UsageError(`${this.command}: missing <${req[pos.length]}>`);
    if (!this.positionals.some((p) => p.endsWith('...')) && pos.length > this.positionals.length)
      throw new UsageError(`${this.command}: too many arguments`);
    return { opts, args: pos };
  }
  help() {
    const lines = [`usage: ${this.command} ${this.positionals.map((p) => '<' + p + '>').join(' ')}`.trimEnd()];
    for (const s of [...this.#specs.values()].sort((a, b) => cmpStr(a.name, b.name))) {
      const flag = (s.alias ? '-' + s.alias + ', ' : '    ') + '--' + s.name + (s.type === 'boolean' ? '' : ' <' + s.type + '>');
      lines.push('  ' + flag.padEnd(24) + s.desc + (s.def !== undefined ? ` (default ${s.def})` : ''));
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------- sandbox fs helpers
class Sandbox {
  #root;
  constructor(root) { this.#root = root; this.cwd = '/'; }
  resolve(p) {
    const abs = path.posix.normalize(path.posix.isAbsolute(p) ? p : path.posix.join(this.cwd, p));
    if (abs.split('/').includes('..')) throw new CliError('path escapes sandbox: ' + p);
    return { virt: abs, real: path.join(this.#root, ...abs.split('/').filter(Boolean)) };
  }
  async exists(p) { try { await fsp.stat(this.resolve(p).real); return true; } catch { return false; } }
  async stat(p) {
    try { return await fsp.stat(this.resolve(p).real); }
    catch (e) { if (e.code === 'ENOENT') throw new NotFoundError(this.resolve(p).virt); throw e; }
  }
  async *walk(p, depth = 0) {
    const { real, virt } = this.resolve(p);
    const entries = (await fsp.readdir(real, { withFileTypes: true })).sort((a, b) => cmpStr(a.name, b.name));
    for (const e of entries) {
      const child = path.posix.join(virt, e.name);
      yield { path: child, name: e.name, dir: e.isDirectory(), depth };
      if (e.isDirectory()) yield* this.walk(child, depth + 1);
    }
  }
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = glob.indexOf('}', i); re += '(' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

class UpperCaseTransform extends Transform {
  constructor() { super(); this.bytes = 0; }
  _transform(chunk, _enc, cb) { this.bytes += chunk.length; cb(null, Buffer.from(chunk.toString('utf8').toUpperCase())); }
}

// ---------------------------------------------------------------- commands
const registry = new Map();
function command(name, positionals, configure, run, summary) {
  const parser = new ArgParser(name, positionals);
  configure(parser);
  parser.option('help', { alias: 'h', desc: 'show help' });
  registry.set(name, { parser, run, summary });
}

command('mkdir', ['dir...'], (p) => p.option('parents', { alias: 'p', desc: 'create parents' }), async (ctx, { opts, args }) => {
  for (const d of args) {
    const { real, virt } = ctx.fs.resolve(d);
    if (!opts.parents && !(await ctx.fs.exists(path.posix.dirname(virt)))) throw new NotFoundError(path.posix.dirname(virt));
    await fsp.mkdir(real, { recursive: opts.parents });
    ctx.out(`created ${virt}`);
  }
}, 'create directories');

command('write', ['file', 'text...'], (p) => p
  .option('append', { alias: 'a', desc: 'append instead of overwrite' })
  .option('repeat', { alias: 'r', type: 'number', default: 1, desc: 'repeat text' })
  .option('newline', { alias: 'n', default: true, desc: 'end with newline' }), async (ctx, { opts, args }) => {
  const [file, ...words] = args;
  const text = (words.length ? words.join(' ') : ctx.stdin) ?? '';
  const body = Array.from({ length: opts.repeat }, () => text + (opts.newline ? '\n' : '')).join('');
  const { real, virt } = ctx.fs.resolve(file);
  await (opts.append ? fsp.appendFile(real, body) : fsp.writeFile(real, body));
  ctx.out(`${opts.append ? 'appended' : 'wrote'} ${Buffer.byteLength(body)} bytes to ${virt}`);
}, 'write text to a file');

command('cat', ['file...'], (p) => p.option('number', { alias: 'n', desc: 'number lines' }), async (ctx, { opts, args }) => {
  let n = 0;
  for (const f of args) {
    await ctx.fs.stat(f);
    const text = await fsp.readFile(ctx.fs.resolve(f).real, 'utf8');
    for (const line of text.replace(/\n$/, '').split('\n')) ctx.out(opts.number ? String(++n).padStart(3) + '  ' + line : line);
  }
}, 'print files');

command('mv', ['src', 'dst'], (p) => p.option('force', { alias: 'f', desc: 'overwrite' }), async (ctx, { opts, args: [src, dst] }) => {
  await ctx.fs.stat(src);
  let target = ctx.fs.resolve(dst);
  if (await ctx.fs.exists(dst) && (await ctx.fs.stat(dst)).isDirectory()) target = ctx.fs.resolve(path.posix.join(target.virt, path.posix.basename(src)));
  else if (await ctx.fs.exists(dst) && !opts.force) throw new CliError(`refusing to overwrite ${target.virt} (use -f)`);
  await fsp.rename(ctx.fs.resolve(src).real, target.real);
  ctx.out(`moved ${ctx.fs.resolve(src).virt} -> ${target.virt}`);
}, 'move or rename');

command('cp', ['src', 'dst'], (p) => p.option('upper', { alias: 'u', desc: 'uppercase while copying' }), async (ctx, { opts, args: [src, dst] }) => {
  await ctx.fs.stat(src);
  const a = ctx.fs.resolve(src), b = ctx.fs.resolve(dst);
  const t = opts.upper ? new UpperCaseTransform() : new Transform({ transform(c, _e, cb) { cb(null, c); } });
  await pipelineP(fs.createReadStream(a.real), t, fs.createWriteStream(b.real));
  ctx.out(`copied ${a.virt} -> ${b.virt}${opts.upper ? ' (uppercased ' + t.bytes + ' bytes)' : ''}`);
}, 'copy a file through a stream pipeline');

command('rm', ['path...'], (p) => p.option('recursive', { alias: 'r', desc: 'remove dirs' }).option('force', { alias: 'f', desc: 'ignore missing' }), async (ctx, { opts, args }) => {
  for (const target of args) {
    if (!(await ctx.fs.exists(target))) { if (opts.force) continue; throw new NotFoundError(ctx.fs.resolve(target).virt); }
    const st = await ctx.fs.stat(target);
    if (st.isDirectory() && !opts.recursive) throw new CliError(`${ctx.fs.resolve(target).virt} is a directory (use -r)`);
    await fsp.rm(ctx.fs.resolve(target).real, { recursive: true });
    ctx.out('removed ' + ctx.fs.resolve(target).virt);
  }
}, 'remove files');

command('tree', ['dir?'], (p) => p.option('depth', { alias: 'd', type: 'number', desc: 'max depth' }).option('sizes', { alias: 's', desc: 'show sizes' }), async (ctx, { opts, args }) => {
  const root = args[0] || '.';
  ctx.out(ctx.fs.resolve(root).virt);
  let dirs = 0, files = 0;
  const items = [];
  for await (const e of ctx.fs.walk(root)) {
    if (opts.depth !== undefined && e.depth >= opts.depth) continue;
    items.push(e);
  }
  const lastAt = [];
  items.forEach((e, idx) => {
    const parent = path.posix.dirname(e.path);
    const last = !items.slice(idx + 1).some((o) => o.depth === e.depth && path.posix.dirname(o.path) === parent);
    lastAt[e.depth] = last;
    const prefix = lastAt.slice(0, e.depth).map((l) => (l ? '    ' : '|   ')).join('');
    let label = e.name + (e.dir ? '/' : '');
    if (opts.sizes && !e.dir) label += ` [${fs.statSync(ctx.fs.resolve(e.path).real).size}]`;
    ctx.out(prefix + (last ? '`-- ' : '|-- ') + label);
    e.dir ? dirs++ : files++;
  });
  ctx.out(`${dirs} directories, ${files} files`);
}, 'print a sorted tree');

command('find', ['dir', 'pattern'], (p) => p.option('type', { alias: 't', type: 'string', choices: ['f', 'd'], desc: 'filter by type' }), async (ctx, { opts, args: [dir, pattern] }) => {
  const re = globToRegex(pattern);
  const base = ctx.fs.resolve(dir).virt;
  for await (const e of ctx.fs.walk(dir)) {
    const rel = path.posix.relative(base, e.path);
    if (opts.type === 'f' && e.dir) continue;
    if (opts.type === 'd' && !e.dir) continue;
    if (re.test(rel) || re.test(e.name)) ctx.out(e.path);
  }
}, 'find by glob');

command('hash', ['file...'], (p) => p.option('algo', { type: 'string', default: 'sha256', choices: ['sha1', 'sha256', 'md5'], desc: 'hash algorithm' }), async (ctx, { opts, args }) => {
  for (const f of args) {
    await ctx.fs.stat(f);
    const h = crypto.createHash(opts.algo);
    await pipelineP(fs.createReadStream(ctx.fs.resolve(f).real), new Transform({ transform(c, _e, cb) { h.update(c); cb(); } }));
    ctx.out(`${h.digest('hex').slice(0, 20)}  ${ctx.fs.resolve(f).virt}`);
  }
}, 'hash files');

command('du', ['dir?'], () => {}, async (ctx, { args }) => {
  const totals = new Map();
  const base = ctx.fs.resolve(args[0] || '.').virt;
  let grand = 0n;
  for await (const e of ctx.fs.walk(base)) {
    if (e.dir) continue;
    const size = BigInt(fs.statSync(ctx.fs.resolve(e.path).real).size);
    grand += size;
    for (let d = path.posix.dirname(e.path); d.length >= base.length; d = path.posix.dirname(d)) {
      totals.set(d, (totals.get(d) || 0n) + size);
      if (d === '/') break;
    }
  }
  for (const [d, s] of [...totals].sort(([a], [b]) => cmpStr(a, b))) ctx.out(`${String(s).padStart(6)}  ${d}`);
  ctx.out(`total ${grand}`);
}, 'disk usage');

command('grep', ['pattern', 'file...?'], (p) => p.option('ignore-case', { alias: 'i', desc: 'case-insensitive' }).option('count', { alias: 'c', desc: 'count matches' }).option('invert', { alias: 'v', desc: 'invert' }), async (ctx, { opts, args: [pattern, ...files] }) => {
  const re = new RegExp(pattern, opts['ignore-case'] ? 'i' : '');
  const sources = files.length ? await Promise.all(files.map(async (f) => [f, await fsp.readFile(ctx.fs.resolve(f).real, 'utf8')])) : [['-', ctx.stdin || '']];
  let count = 0;
  for (const [name, text] of sources) for (const line of text.split('\n')) {
    if (!line) continue;
    if (re.test(line) !== opts.invert) { count++; if (!opts.count) ctx.out(files.length > 1 ? `${name}:${line}` : line); }
  }
  if (opts.count) ctx.out(String(count));
  if (!count) ctx.status = 1;
}, 'search lines');

command('wc', ['file?'], (p) => p.option('lines', { alias: 'l', desc: 'lines only' }), async (ctx, { opts, args }) => {
  const text = args[0] ? await fsp.readFile(ctx.fs.resolve(args[0]).real, 'utf8') : ctx.stdin || '';
  let lines = 0, words = 0, bytes = 0;
  for await (const line of Readable.from(text.split('\n'))) {
    if (!line) continue;
    lines++; words += line.split(/\s+/).filter(Boolean).length; bytes += Buffer.byteLength(line) + 1;
  }
  ctx.out(opts.lines ? String(lines) : `${lines} ${words} ${bytes}`);
}, 'count lines/words/bytes');

command('sort', [], (p) => p.option('reverse', { alias: 'r', desc: 'reverse' }).option('numeric', { alias: 'n', desc: 'numeric' }).option('unique', { alias: 'u', desc: 'unique' }), async (ctx, { opts }) => {
  let lines = (ctx.stdin || '').split('\n').filter(Boolean);
  lines.sort(opts.numeric ? (a, b) => parseFloat(a) - parseFloat(b) : (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (opts.unique) lines = [...new Set(lines)];
  if (opts.reverse) lines.reverse();
  lines.forEach((l) => ctx.out(l));
}, 'sort stdin');

command('cd', ['dir?'], () => {}, async (ctx, { args }) => {
  const target = ctx.fs.resolve(args[0] || '/');
  if (!(await ctx.fs.stat(target.virt)).isDirectory()) throw new CliError('not a directory: ' + target.virt);
  ctx.fs.cwd = target.virt;
}, 'change directory');

command('pwd', [], () => {}, async (ctx) => ctx.out(ctx.fs.cwd), 'print working directory');

command('set', ['name', 'value...?'], () => {}, async (ctx, { args: [name, ...v] }) => {
  if (!/^[A-Za-z_]\w*$/.test(name)) throw new UsageError('bad variable name ' + name);
  ctx.shell.env[name] = v.join(' ');
}, 'set a variable');

command('alias', ['name?', 'expansion...?'], () => {}, async (ctx, { args: [name, ...rest] }) => {
  if (!name) { for (const [k, v] of [...ctx.shell.aliases].sort()) ctx.out(`alias ${k}='${v}'`); return; }
  ctx.shell.aliases.set(name, rest.join(' '));
}, 'define alias');

command('help', ['cmd?'], () => {}, async (ctx, { args }) => {
  if (args[0]) {
    const c = registry.get(args[0]);
    if (!c) throw new UsageError('no such command ' + args[0]);
    c.parser.help().split('\n').forEach((l) => ctx.out(l));
    return;
  }
  for (const k of [...registry.keys()].sort()) ctx.out(`  ${k.padEnd(6)} ${registry.get(k).summary}`);
}, 'show help');

command('seq', ['from', 'to'], (p) => p.option('step', { alias: 's', type: 'number', default: 1, desc: 'step' }), async (ctx, { opts, args }) => {
  const [a, b] = args.map(Number);
  if (Number.isNaN(a) || Number.isNaN(b) || opts.step <= 0) throw new UsageError('seq needs numbers and positive step');
  for (let x = a; x <= b; x += opts.step) ctx.out(String(x));
}, 'print a sequence');

command('fact', ['n'], (p) => p.option('digits', { desc: 'only digit count' }), async (ctx, { opts, args }) => {
  let r = 1n;
  for (let i = 2n; i <= BigInt(args[0]); i++) r *= i;
  ctx.out(opts.digits ? `${String(r).length} digits` : r.toString());
}, 'bigint factorial');

// ---------------------------------------------------------------- shell
class Shell extends EventEmitter {
  #history = [];
  static MAX_ALIAS_DEPTH = 5;
  constructor(sandbox) {
    super();
    this.fs = sandbox;
    this.env = { HOME: '/', USER: 'tester', '?': 0 };
    this.aliases = new Map([['ll', 'tree -s'], ['count', 'wc -l']]);
  }
  get history() { return this.#history.slice(); }
  expandAlias(words, depth = 0) {
    if (depth > Shell.MAX_ALIAS_DEPTH) throw new CliError('alias loop detected at ' + words[0]);
    const exp = this.aliases.get(words[0]);
    if (!exp) return words;
    const inner = tokenize(exp, this.env).filter((t) => t.type === 'word').map((t) => t.value);
    return this.expandAlias([...inner, ...words.slice(1)], depth + 1);
  }
  async runOne(words, stdin) {
    const [name, ...argv] = this.expandAlias(words);
    const cmd = registry.get(name);
    if (!cmd) throw new CliError(`command not found: ${name}`, 127);
    const parsed = cmd.parser.parse(argv);
    const lines = [];
    const ctx = { fs: this.fs, shell: this, stdin, out: (l) => lines.push(l), status: 0 };
    if (parsed.opts.help) { lines.push(...cmd.parser.help().split('\n')); return { lines, status: 0 }; }
    await cmd.run(ctx, parsed);
    return { lines, status: ctx.status };
  }
  async exec(line) {
    this.#history.push(line);
    this.emit('line', line);
    let statements;
    try { statements = splitPipelines(tokenize(line, this.env)); }
    catch (e) { this.emit('output', `error: ${e.name}: ${e.message}`); this.env['?'] = e.code; return e.code; }
    let status = 0;
    for (const stmt of statements) {
      let input;
      try {
        let res;
        for (const [idx, words] of stmt.entries()) {
          res = await this.runOne(words, input);
          input = res.lines.join('\n') + (res.lines.length ? '\n' : '');
          if (idx < stmt.length - 1) continue;
        }
        res.lines.forEach((l) => this.emit('output', l));
        status = res.status;
      } catch (e) {
        if (!(e instanceof CliError)) this.emit('output', `internal: ${e.code || e.name}`);
        else this.emit('output', `error: ${e.name}: ${e.message}`);
        status = e.code && Number.isInteger(e.code) ? e.code : 1;
      } finally {
        this.env['?'] = status;
      }
    }
    return status;
  }
}

// ---------------------------------------------------------------- script
const SCRIPT = [
  'help',
  'help write',
  'pwd',
  'mkdir -p projects/alpha/src projects/beta docs',
  'mkdir nope/child',
  'write projects/alpha/src/main.js "console.log(\'hi\');"',
  'write -a projects/alpha/src/main.js "// trailing comment"',
  'write -r 3 projects/alpha/README.md "Alpha project line"',
  'write --no-newline docs/notes.txt \'single quoted $USER stays\'',
  'write docs/greet.txt "hello $USER from ${HOME} and ${MISSING:-fallback}"',
  'set LEVEL warn',
  'write docs/log.txt "info boot" ; write -a docs/log.txt "warn disk low" ; write -a docs/log.txt "error crash" ; write -a docs/log.txt "WARN cpu hot"',
  'cat -n docs/log.txt',
  'grep -i $LEVEL docs/log.txt',
  'grep -c -v warn docs/log.txt',
  'grep nothing-here docs/log.txt',
  'echo $?',
  'write docs/status.txt "last status was $?"',
  'cat docs/status.txt docs/greet.txt docs/notes.txt',
  'cat docs/log.txt | grep -i warn | wc',
  'seq 1 12 -s 3 | sort -rn',
  'write projects/beta/data.csv "b,2" ; write -a projects/beta/data.csv "a,1" ; write -a projects/beta/data.csv "c,3" ; write -a projects/beta/data.csv "a,1"',
  'cat projects/beta/data.csv | sort -u',
  'cp -u projects/beta/data.csv projects/beta/upper.csv',
  'cp docs/greet.txt projects/beta/greet.copy',
  'mv docs/notes.txt projects/alpha',
  'mv docs/greet.txt projects/beta/greet.copy',
  'mv -f docs/greet.txt projects/beta/greet.copy',
  'mv missing.txt x',
  'tree',
  'll projects',
  'tree -d 1',
  'find / "*.{js,md}"',
  'find projects "**/*.c?v" -t f',
  'find / "*" --type d',
  'find / x --type z',
  'hash projects/beta/upper.csv projects/alpha/README.md',
  'hash --algo md5 projects/alpha/src/main.js',
  'du',
  'cd projects/alpha ; pwd ; tree ; cat ../beta/data.csv | count ; cd /',
  'cd ../..',
  'alias loop1 loop2 ; alias loop2 loop1',
  'loop1',
  'alias',
  'rm projects',
  'rm -rf projects/beta nothing',
  'tree -s',
  'fact 25 ; fact 100 --digits',
  'write --repeat many x y',
  'write -z file',
  'write',
  'tree extra1 extra2',
  'unknowncmd arg',
  'write "unterminated',
  "cat 'still open",
  'sort --numeric=false --reverse=true',
  'grep --help',
  'wc -l docs/log.txt # trailing comment ignored',
  'write escaped\\ name.txt a\\ b\\"c',
  'cat "escaped name.txt"',
  'seq 3 1 ; seq a b',
  'du /',
];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcorp-'));
  const shell = new Shell(new Sandbox(tmp));
  const statusCounts = {};
  let outputLines = 0;
  shell.on('line', (l) => console.log('$ ' + l));
  shell.on('output', (l) => { outputLines++; console.log('  ' + l); });
  // alias for echo implemented as a tiny closure-registered command
  command('echo', ['word...?'], () => {}, async (ctx, { args }) => ctx.out(args.join(' ')), 'echo words');
  try {
    for (const line of SCRIPT) {
      const st = await shell.exec(line);
      statusCounts[st] = (statusCounts[st] || 0) + 1;
    }
    // tokenizer self-check
    const samples = ['a "b c" d', "x'y z'w", 'p\\ q|r;s', '$USER${USER}"$USER"'];
    for (const s of samples) console.log('tokens ' + JSON.stringify(tokenize(s, shell.env).map((t) => t.type === 'word' ? t.value : '<' + t.type + '>')));
    const globs = [['*.js', 'a.js'], ['*.js', 'd/a.js'], ['**/*.js', 'd/e/a.js'], ['?.{md,txt}', 'x.md'], ['f(1).txt', 'f(1).txt']];
    for (const [g, p] of globs) console.log(`glob ${g.padEnd(12)} ${p.padEnd(10)} ${globToRegex(g).test(p)}`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  console.log('history entries ' + shell.history.length + ', output lines ' + outputLines);
  console.log('status histogram ' + JSON.stringify(Object.keys(statusCounts).sort((a, b) => a - b).map((k) => [Number(k), statusCounts[k]])));
  console.log('sandbox removed ' + !fs.existsSync(tmp));
}

process.on('exit', () => console.log('bye'));
main().catch((e) => { console.log('fatal ' + e.message); process.exitCode = 1; });
