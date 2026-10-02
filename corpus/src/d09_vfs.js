// d09: virtual file system — paths, inodes, permissions, symlinks,
// journaling with transactions, undo/redo, globbing, async walkers.
'use strict';

const say = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// ---------------------------------------------------------------- errors
class FsError extends Error {
  constructor(code, path, detail = '') {
    super(`${code}: ${path}${detail ? ' (' + detail + ')' : ''}`);
    this.code = code;
    this.path = path;
  }
  get name() { return 'FsError'; }
  static is(e, ...codes) {
    return e instanceof FsError && (codes.length === 0 || codes.includes(e.code));
  }
}
class PermissionError extends FsError {
  constructor(path, need) {
    super('EACCES', path, 'need ' + need);
    this.need = need;
  }
}
class LoopError extends FsError {
  constructor(path) { super('ELOOP', path); }
}

// ---------------------------------------------------------------- paths
const Path = {
  sep: '/',
  split(p) {
    return p.split('/').filter((s) => s.length && s !== '.');
  },
  normalize(p, cwd = '/') {
    const abs = p.startsWith('/') ? p : cwd.replace(/\/$/, '') + '/' + p;
    const stack = [];
    for (const seg of Path.split(abs)) {
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    return '/' + stack.join('/');
  },
  dirname(p) {
    const n = Path.normalize(p);
    const i = n.lastIndexOf('/');
    return i <= 0 ? '/' : n.slice(0, i);
  },
  basename(p) {
    const m = /(?<=\/|^)(?<base>[^/]*)\/*$/.exec(p);
    return m?.groups?.base ?? '';
  },
  extname(p) {
    const { ext = '' } = /(?<!^|\/)(?<ext>\.[^./]+)$/.exec(Path.basename(p))?.groups ?? {};
    return ext;
  },
  join(...parts) {
    return Path.normalize(parts.join('/'));
  },
  relative(from, to) {
    const a = Path.split(Path.normalize(from)), b = Path.split(Path.normalize(to));
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/') || '.';
  },
};

// ---------------------------------------------------------------- inodes
let INO = 0;
class Inode {
  #ino;
  constructor(owner, group, mode) {
    if (new.target === Inode) throw new TypeError('abstract inode');
    this.#ino = ++INO;
    Object.assign(this, { owner, group, mode });
    this.nlink = 1;
    this.mtime = 0;
  }
  get ino() { return this.#ino; }
  get type() { return 'inode'; }
  get size() { return 0; }
  modeString() {
    const t = { dir: 'd', file: '-', link: 'l' }[this.type];
    let s = t;
    for (let shift = 6; shift >= 0; shift -= 3) {
      const bits = (this.mode >> shift) & 7;
      s += (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
    }
    return s;
  }
  static isInode(x) { return x != null && #ino in x; }
}
class FileNode extends Inode {
  #data = '';
  get type() { return 'file'; }
  get data() { return this.#data; }
  set data(v) {
    this.#data = String(v);
    this.mtime++;
  }
  get size() { return new TextEncoder().encode(this.#data).length; }
}
class DirNode extends Inode {
  constructor(...args) {
    super(...args);
    this.entries = new Map();
  }
  get type() { return 'dir'; }
  get size() { return this.entries.size * 32; }
  *[Symbol.iterator]() {
    yield* [...this.entries.keys()].sort();
  }
}
class LinkNode extends Inode {
  constructor(owner, group, target) {
    super(owner, group, 0o777);
    this.target = target;
  }
  get type() { return 'link'; }
  get size() { return this.target.length; }
}

// ---------------------------------------------------------------- users
class User {
  static #registry = new Map();
  static {
    User.ROOT = new User('root', 0, ['root']);
  }
  constructor(name, uid, groups) {
    Object.assign(this, { name, uid, groups: new Set(groups) });
    User.#registry.set(name, this);
  }
  static get(name) {
    const u = User.#registry.get(name);
    if (!u) throw new FsError('ENOUSER', name);
    return u;
  }
  get isRoot() { return this.uid === 0; }
}
new User('alice', 1000, ['staff', 'dev']);
new User('bob', 1001, ['staff']);
new User('eve', 1002, ['guests']);

// ---------------------------------------------------------------- VFS core
class Vfs {
  #root;
  #journal = [];
  #tx = null;
  #undo = [];
  #redo = [];
  #hooks = { write: [], unlink: [] };
  #clock = 0;
  static MAX_LINKS = 8;

  constructor() {
    this.#root = new DirNode('root', 'root', 0o755);
    this.user = User.ROOT;
    this.cwd = '/';
  }
  as(name, fn) {
    const prev = this.user;
    this.user = User.get(name);
    try {
      return fn(this);
    } finally {
      this.user = prev;
    }
  }
  on(evt, fn) {
    (this.#hooks[evt] ??= []).push(fn);
    return () => (this.#hooks[evt] = this.#hooks[evt].filter((f) => f !== fn));
  }
  #emit(evt, ...args) {
    for (const f of this.#hooks[evt] ?? []) f?.(...args);
  }
  #can(node, bit) {
    const u = this.user;
    if (u.isRoot) return true;
    const shift = node.owner === u.name ? 6 : u.groups.has(node.group) ? 3 : 0;
    return ((node.mode >> shift) & bit) !== 0;
  }
  #require(node, bit, path) {
    if (!this.#can(node, bit)) throw new PermissionError(path, bit === 4 ? 'r' : bit === 2 ? 'w' : 'x');
  }
  resolve(path, { follow = true, depth = 0 } = {}) {
    if (depth > Vfs.MAX_LINKS) throw new LoopError(path);
    const segs = Path.split(Path.normalize(path, this.cwd));
    let node = this.#root;
    let cur = '/';
    let parent = null;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (node.type !== 'dir') throw new FsError('ENOTDIR', cur);
      this.#require(node, 1, cur);
      const next = node.entries.get(seg);
      if (!next) throw new FsError('ENOENT', Path.join(cur, seg));
      const isLast = i === segs.length - 1;
      if (next.type === 'link' && (follow || !isLast)) {
        const target = Path.normalize(next.target, cur);
        const rest = segs.slice(i + 1).join('/');
        return this.resolve(rest ? Path.join(target, rest) : target, { follow, depth: depth + 1 });
      }
      parent = node;
      node = next;
      cur = Path.join(cur, seg);
    }
    return { node, parent, path: cur };
  }
  #parentOf(path) {
    const abs = Path.normalize(path, this.cwd);
    const { node: dir, path: dpath } = this.resolve(Path.dirname(abs));
    if (dir.type !== 'dir') throw new FsError('ENOTDIR', dpath);
    return { dir, name: Path.basename(abs), abs };
  }
  // journaling --------------------------------------------------------
  #record(entry) {
    entry.seq = ++this.#clock;
    entry.user = this.user.name;
    (this.#tx ?? this.#journal).push(entry);
    if (!this.#tx) {
      this.#undo.push([entry]);
      this.#redo.length = 0;
    }
  }
  transaction(label, fn) {
    if (this.#tx) throw new FsError('ENESTED', label);
    this.#tx = [];
    let ok = false;
    try {
      const r = fn(this);
      ok = true;
      return r;
    } finally {
      const entries = this.#tx;
      this.#tx = null;
      if (ok) {
        this.#journal.push({ seq: ++this.#clock, op: 'begin', label, user: this.user.name }, ...entries, { seq: ++this.#clock, op: 'commit', label, user: this.user.name });
        if (entries.length) this.#undo.push(entries);
        this.#redo.length = 0;
      } else {
        for (const e of entries.slice().reverse()) this.#revert(e);
        this.#journal.push({ seq: ++this.#clock, op: 'rollback', label, n: entries.length, user: this.user.name });
      }
    }
  }
  #revert(e) {
    const prevTx = this.#tx;
    this.#tx = [];
    const prevUser = this.user;
    this.user = User.ROOT;
    try {
      switch (e.op) {
        case 'write':
          if (e.before === null) this.#rawUnlink(e.path);
          else this.#rawNode(e.path).data = e.before;
          break;
        case 'mkdir':
          this.#rawUnlink(e.path);
          break;
        case 'unlink':
          this.#rawAttach(e.path, e.node);
          break;
        case 'symlink':
          this.#rawUnlink(e.path);
          break;
        case 'chmod':
          this.#rawNode(e.path).mode = e.before;
          break;
        case 'rename':
          this.#rawAttach(e.from, this.#rawDetach(e.to));
          break;
        default:
          throw new FsError('EJOURNAL', e.op);
      }
    } finally {
      this.#tx = prevTx;
      this.user = prevUser;
    }
  }
  #apply(e) {
    const prevUser = this.user;
    this.user = User.get(e.user);
    try {
      switch (e.op) {
        case 'write': return this.writeFile(e.path, e.after);
        case 'mkdir': return this.mkdir(e.path);
        case 'unlink': return this.unlink(e.path);
        case 'symlink': return this.symlink(e.target, e.path);
        case 'chmod': return this.chmod(e.path, e.after);
        case 'rename': return this.rename(e.from, e.to);
      }
    } finally {
      this.user = prevUser;
    }
  }
  undo() {
    const batch = this.#undo.pop();
    if (!batch) return false;
    for (const e of batch.slice().reverse()) this.#revert(e);
    this.#redo.push(batch);
    return batch.length;
  }
  redo() {
    const batch = this.#redo.pop();
    if (!batch) return false;
    const saved = this.#redo.slice();
    this.#tx = [];
    try {
      for (const e of batch) this.#apply(e);
    } finally {
      const redone = this.#tx;
      this.#tx = null;
      this.#undo.push(redone);
      this.#journal.push(...redone);
      this.#redo = saved;
    }
    return batch.length;
  }
  get journal() {
    return this.#journal.map(({ seq, op, path = '', label = '', user }) => `${seq}:${user}:${op}${path ? ' ' + path : ''}${label ? ' [' + label + ']' : ''}`);
  }
  // raw helpers used by undo (no permission checks)
  #rawNode(path) {
    return this.resolve(path, { follow: false }).node;
  }
  #rawDetach(path) {
    const { dir, name } = this.#parentOf(path);
    const n = dir.entries.get(name);
    dir.entries.delete(name);
    return n;
  }
  #rawUnlink(path) {
    this.#rawDetach(path);
  }
  #rawAttach(path, node) {
    const { dir, name } = this.#parentOf(path);
    dir.entries.set(name, node);
  }
  // public ops --------------------------------------------------------
  mkdir(path, { recursive = false, mode = 0o755 } = {}) {
    if (recursive) {
      let cur = '/';
      let made = 0;
      for (const seg of Path.split(Path.normalize(path, this.cwd))) {
        cur = Path.join(cur, seg);
        try {
          const { node } = this.resolve(cur);
          if (node.type !== 'dir') throw new FsError('ENOTDIR', cur);
        } catch (e) {
          if (!FsError.is(e, 'ENOENT')) throw e;
          this.mkdir(cur, { mode });
          made++;
        }
      }
      return made;
    }
    const { dir, name, abs } = this.#parentOf(path);
    this.#require(dir, 2, Path.dirname(abs));
    if (dir.entries.has(name)) throw new FsError('EEXIST', abs);
    const [grp] = this.user.groups;
    dir.entries.set(name, new DirNode(this.user.name, grp, mode));
    this.#record({ op: 'mkdir', path: abs });
    return 1;
  }
  writeFile(path, data, { append = false } = {}) {
    const { dir, name, abs } = this.#parentOf(path);
    let node = dir.entries.get(name);
    let before = null;
    if (node?.type === 'link') return this.writeFile(this.resolve(abs).path, data, { append });
    if (node) {
      if (node.type === 'dir') throw new FsError('EISDIR', abs);
      this.#require(node, 2, abs);
      before = node.data;
    } else {
      this.#require(dir, 2, Path.dirname(abs));
      node = new FileNode(this.user.name, [...this.user.groups][0], 0o644);
      dir.entries.set(name, node);
    }
    node.data = append ? (before ?? '') + data : data;
    this.#record({ op: 'write', path: abs, before, after: node.data });
    this.#emit('write', abs, node.size);
    return node.size;
  }
  readFile(path) {
    const { node, path: real } = this.resolve(path);
    if (node.type === 'dir') throw new FsError('EISDIR', real);
    this.#require(node, 4, real);
    return node.data;
  }
  readdir(path = '.') {
    const { node, path: real } = this.resolve(path);
    if (node.type !== 'dir') throw new FsError('ENOTDIR', real);
    this.#require(node, 4, real);
    return [...node];
  }
  unlink(path, { recursive = false } = {}) {
    const { dir, name, abs } = this.#parentOf(path);
    const node = dir.entries.get(name);
    if (!node) throw new FsError('ENOENT', abs);
    this.#require(dir, 2, Path.dirname(abs));
    if (node.type === 'dir' && node.entries.size && !recursive) throw new FsError('ENOTEMPTY', abs);
    dir.entries.delete(name);
    this.#record({ op: 'unlink', path: abs, node });
    this.#emit('unlink', abs, node.type);
  }
  symlink(target, path) {
    const { dir, name, abs } = this.#parentOf(path);
    this.#require(dir, 2, Path.dirname(abs));
    if (dir.entries.has(name)) throw new FsError('EEXIST', abs);
    dir.entries.set(name, new LinkNode(this.user.name, [...this.user.groups][0], target));
    this.#record({ op: 'symlink', path: abs, target });
  }
  readlink(path) {
    const { node, path: p } = this.resolve(path, { follow: false });
    if (node.type !== 'link') throw new FsError('EINVAL', p);
    return node.target;
  }
  chmod(path, mode) {
    const { node, path: real } = this.resolve(path);
    if (!this.user.isRoot && node.owner !== this.user.name) throw new PermissionError(real, 'owner');
    const before = node.mode;
    node.mode = typeof mode === 'string' ? parseInt(mode, 8) : mode;
    this.#record({ op: 'chmod', path: real, before, after: node.mode });
  }
  rename(from, to) {
    const a = this.#parentOf(from), b = this.#parentOf(to);
    const node = a.dir.entries.get(a.name);
    if (!node) throw new FsError('ENOENT', a.abs);
    this.#require(a.dir, 2, Path.dirname(a.abs));
    this.#require(b.dir, 2, Path.dirname(b.abs));
    if ((b.abs + '/').startsWith(a.abs + '/')) throw new FsError('EINVAL', b.abs, 'into itself');
    if (b.dir.entries.has(b.name)) throw new FsError('EEXIST', b.abs);
    a.dir.entries.delete(a.name);
    b.dir.entries.set(b.name, node);
    this.#record({ op: 'rename', from: a.abs, to: b.abs, path: a.abs + '->' + b.abs });
  }
  stat(path, lstat = false) {
    const { node, path: p } = this.resolve(path, { follow: !lstat });
    return { path: p, type: node.type, mode: node.modeString(), owner: node.owner, group: node.group, size: node.size };
  }
  exists(path) {
    try {
      this.resolve(path);
      return true;
    } catch (e) {
      if (FsError.is(e, 'ENOENT', 'ENOTDIR', 'ELOOP')) return false;
      throw e;
    }
  }
  *walk(path = '/', { depthFirst = true } = {}) {
    const { node, path: base } = this.resolve(path);
    const queue = [[base, node, 0]];
    while (queue.length) {
      const [p, n, d] = depthFirst ? queue.pop() : queue.shift();
      const cmd = yield { path: p, type: n.type, depth: d, size: n.size };
      if (cmd === 'skip' || n.type !== 'dir') continue;
      const kids = [...n].map((k) => [Path.join(p, k), n.entries.get(k), d + 1]);
      queue.push(...(depthFirst ? kids.reverse() : kids));
    }
  }
  tree(path = '/') {
    const lines = [];
    const rec = (p, prefix) => {
      const { node } = this.resolve(p, { follow: false });
      if (node.type !== 'dir') return;
      const names = [...node];
      names.forEach((name, i) => {
        const child = node.entries.get(name);
        const last = i === names.length - 1;
        const suffix = child.type === 'link' ? ` -> ${child.target}` : child.type === 'dir' ? '/' : ` (${child.size})`;
        lines.push(`${prefix}${last ? '`-- ' : '|-- '}${name}${suffix}`);
        if (child.type === 'dir') rec(Path.join(p, name), prefix + (last ? '    ' : '|   '));
      });
    };
    rec(path, '');
    return lines;
  }
  get root() { return this.#root; }
}

// ---------------------------------------------------------------- glob
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    switch (c) {
      case '*':
        if (glob[i + 1] === '*') {
          re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
          i += glob[i + 2] === '/' ? 2 : 1;
          break;
        }
        re += '[^/]*';
        break;
      case '?':
        re += '[^/]';
        break;
      case '{': {
        const end = glob.indexOf('}', i);
        re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
        break;
      }
      case '.':
      case '(':
      case ')':
      case '+':
      case '^':
      case '$':
      case '|':
        re += '\\' + c;
        break;
      default:
        re += c;
    }
  }
  return new RegExp('^' + re + '$', 'u');
}
function glob(fs, pattern, base = '/') {
  const re = globToRegExp(pattern);
  const hits = [];
  for (const entry of fs.walk(base)) {
    const rel = Path.relative(base, entry.path);
    if (rel !== '.' && re.test(rel)) hits.push(rel);
  }
  return hits.sort();
}

// ---------------------------------------------------------------- scenario
function attempt(label, fn) {
  try {
    const r = fn();
    say('ok  ', label, r === undefined ? '' : r);
    return r;
  } catch (e) {
    if (e instanceof FsError) say('fail', label, e.code, e.name, e instanceof PermissionError ? 'perm:' + e.need : '', e.message);
    else throw e;
  }
}

say('== paths ==');
for (const p of ['/a/b/../c/./d', 'x/y/../../..', '/', 'rel/file.tar.gz', '/.hidden', '/dir/']) {
  say(JSON.stringify(p), '->', Path.normalize(p, '/home/alice'), Path.dirname(p), JSON.stringify(Path.basename(p)), JSON.stringify(Path.extname(p)));
}
say('relative', Path.relative('/a/b/c', '/a/d/e'), Path.relative('/a', '/a'), Path.relative('/x/y', '/x'));

say('== setup ==');
const fs = new Vfs();
const events = [];
const off = fs.on('write', (p, size) => events.push(`w:${p}:${size}`));
fs.on('unlink', (p, t) => events.push(`u:${p}:${t}`));
attempt('mkdir -p', () => fs.mkdir('/home/alice/projects/app', { recursive: true }));
attempt('mkdir bob', () => fs.mkdir('/home/bob'));
attempt('mkdir tmp', () => fs.mkdir('/tmp', { mode: 0o777 }));
attempt('chown-ish', () => {
  const h = fs.resolve('/home/alice').node;
  const b = fs.resolve('/home/bob').node;
  [h.owner, h.group, b.owner, b.group] = ['alice', 'dev', 'bob', 'staff'];
  fs.resolve('/home/alice/projects').node.owner = 'alice';
  fs.resolve('/home/alice/projects/app').node.owner = 'alice';
  return [h.modeString(), b.modeString()];
});
fs.as('alice', (f) => {
  attempt('alice write readme', () => f.writeFile('/home/alice/projects/app/README.md', '# App\nhello\n'));
  attempt('alice write main', () => f.writeFile('/home/alice/projects/app/main.js', 'console.log(1)\n'));
  attempt('alice mkdir src', () => f.mkdir('/home/alice/projects/app/src'));
  for (const [i, n] of ['util', 'core', 'ui'].entries()) {
    attempt(`alice write ${n}`, () => f.writeFile(`/home/alice/projects/app/src/${n}.js`, `export const ${n} = ${i * 10};\n`.repeat(i + 1)));
  }
  attempt('alice write into bob', () => f.writeFile('/home/bob/x.txt', 'nope'));
  attempt('alice chmod own', () => f.chmod('/home/alice/projects/app/src/core.js', '600'));
});
fs.as('bob', (f) => {
  attempt('bob read readme', () => f.readFile('/home/alice/projects/app/README.md').split('\n')[0]);
  attempt('bob read core (600)', () => f.readFile('/home/alice/projects/app/src/core.js'));
  attempt('bob chmod alice file', () => f.chmod('/home/alice/projects/app/main.js', 0o777));
  attempt('bob write tmp', () => f.writeFile('/tmp/bob.log', 'line1\n'));
  attempt('bob append tmp', () => f.writeFile('/tmp/bob.log', 'line2\n', { append: true }));
});
attempt('eve cannot enter after chmod', () => {
  fs.chmod('/home/alice', 0o750);
  return fs.as('eve', (f) => f.readdir('/home/alice'));
});
attempt('bob enters as staff? (group dev)', () => fs.as('bob', (f) => f.readdir('/home/alice')));
attempt('alice lists', () => fs.as('alice', (f) => f.readdir('/home/alice/projects/app')));
attempt('unknown user', () => fs.as('mallory', () => 1));

say('== symlinks ==');
attempt('link current', () => fs.symlink('/home/alice/projects/app', '/current'));
attempt('relative link', () => fs.symlink('../src/util.js', '/home/alice/projects/app/src/../util-link.js'));
attempt('read via link', () => fs.readFile('/current/src/util.js').trim());
attempt('read relative link', () => fs.readFile('/home/alice/projects/app/util-link.js'));
attempt('lstat', () => fs.stat('/current', true));
attempt('stat', () => fs.stat('/current'));
attempt('readlink', () => fs.readlink('/current'));
attempt('loop a->b', () => fs.symlink('/loopb', '/loopa'));
attempt('loop b->a', () => fs.symlink('/loopa', '/loopb'));
attempt('resolve loop', () => fs.readFile('/loopa'));
attempt('exists loop', () => fs.exists('/loopa'));
attempt('dangling', () => (fs.symlink('/nowhere', '/dangle'), fs.exists('/dangle')));
attempt('write through link', () => fs.writeFile('/current/NOTES', 'via link'));
attempt('notes real path', () => fs.readFile('/home/alice/projects/app/NOTES'));

say('== tree ==');
for (const line of fs.tree('/')) say(line);

say('== walk / glob ==');
{
  const seen = [];
  const it = fs.walk('/home');
  let step = it.next();
  while (!step.done) {
    const { path, depth, type } = step.value;
    seen.push(`${'.'.repeat(depth)}${Path.basename(path) || '/'}${type === 'dir' ? '/' : ''}`);
    step = it.next(path.endsWith('/src') ? 'skip' : undefined);
  }
  say('dfs skip src', seen.join(' '));
  const bfs = [...fs.walk('/home/alice/projects', { depthFirst: false })].map((e) => e.depth);
  say('bfs depths', bfs.join(''));
  for (const g of ['**/*.js', 'home/*/projects/app/*.{md,js}', '**/src/?ore.js', '*', 'tmp/**']) say('glob', g, glob(fs, g));
  say('glob regexp', String(globToRegExp('a/**/b?.{x,y}')));
}

say('== journal / transactions ==');
attempt('tx commit', () =>
  fs.transaction('scaffold', (f) => {
    f.mkdir('/srv');
    f.writeFile('/srv/a.txt', 'A');
    f.writeFile('/srv/b.txt', 'B');
    return f.readdir('/srv');
  })
);
attempt('tx rollback', () =>
  fs.transaction('broken', (f) => {
    f.writeFile('/srv/a.txt', 'A2');
    f.unlink('/srv/b.txt');
    f.mkdir('/srv/sub');
    f.writeFile('/srv/sub/c.txt', 'C');
    f.readFile('/srv/missing');
  })
);
attempt('after rollback', () => [fs.readdir('/srv'), fs.readFile('/srv/a.txt'), fs.readFile('/srv/b.txt')]);
attempt('nested tx', () => fs.transaction('outer', (f) => f.transaction('inner', () => 1)));
attempt('rollback perm', () =>
  fs.as('eve', (f) =>
    f.transaction('eve-tx', (g) => {
      g.writeFile('/tmp/eve.txt', 'hi');
      g.writeFile('/srv/a.txt', 'hacked');
    })
  )
);
attempt('tmp after eve', () => fs.readdir('/tmp'));

say('== undo / redo ==');
attempt('rename', () => fs.rename('/srv/a.txt', '/tmp/a-moved.txt'));
attempt('rename into itself', () => fs.rename('/srv', '/srv/inner'));
attempt('state', () => [fs.readdir('/srv'), fs.exists('/tmp/a-moved.txt')]);
attempt('undo rename', () => fs.undo());
attempt('state', () => [fs.readdir('/srv'), fs.exists('/tmp/a-moved.txt')]);
attempt('undo tx', () => fs.undo());
attempt('srv gone', () => fs.exists('/srv'));
attempt('redo tx', () => fs.redo());
attempt('srv back', () => [fs.readdir('/srv'), fs.readFile('/srv/b.txt')]);
attempt('redo rename', () => fs.redo());
attempt('redo empty', () => fs.redo());
{
  let n = 0, r;
  do {
    r = fs.undo();
    if (r) n += r;
    if (n > 5) break;
  } while (r);
  say('undid entries', n, 'tree now', fs.tree('/').length, 'lines');
  let m = 0;
  while (fs.redo()) m++;
  say('redid batches', m, 'tree now', fs.tree('/').length, 'lines');
}
attempt('rm non-empty', () => fs.unlink('/home/alice/projects/app/src'));
attempt('rm -r', () => fs.unlink('/home/alice/projects/app/src', { recursive: true }));
attempt('undo rm -r', () => fs.undo());
attempt('src back', () => fs.readdir('/current/src'));
off();
attempt('write after off', () => fs.writeFile('/tmp/silent', 'x'));
say('events', events.length, events.slice(0, 6));
say('journal size', fs.journal.length);
for (const line of fs.journal.slice(0, 12)) say('  ', line);
say('journal tail', fs.journal.slice(-3));

say('== disk usage & reports ==');
function du(f, path) {
  const { node } = f.resolve(path, { follow: false });
  if (node.type !== 'dir') return node.size;
  let total = node.size;
  for (const name of node) total += du(f, Path.join(path, name));
  return total;
}
for (const p of ['/', '/home', '/home/alice/projects/app/src', '/tmp']) say('du', p, du(fs, p));
{
  const byExt = new Map();
  for (const { path, type, size } of fs.walk('/')) {
    if (type !== 'file') continue;
    const ext = Path.extname(path) || '(none)';
    const cur = byExt.get(ext) ?? { count: 0, bytes: 0 };
    byExt.set(ext, { count: cur.count + 1, bytes: cur.bytes + size });
  }
  say('by ext', Object.fromEntries([...byExt].sort()));
  const owners = {};
  const visit = function (node) {
    owners[node.owner] = (owners[node.owner] || 0) + 1;
    if (node.type === 'dir') for (const k of node) visit(node.entries.get(k));
    return arguments.length;
  };
  say('visit args', visit(fs.root, 'extra', 'args'), 'owners', owners);
}

say('== serialization ==');
function snapshot(f) {
  const enc = (node) => {
    switch (node.type) {
      case 'dir':
        return { t: 'd', m: node.mode, o: node.owner, e: Object.fromEntries([...node].map((k) => [k, enc(node.entries.get(k))])) };
      case 'file':
        return { t: 'f', m: node.mode, o: node.owner, d: node.data };
      case 'link':
        return { t: 'l', to: node.target };
    }
  };
  return JSON.stringify(enc(f.root), (k, v) => (k === 'm' ? v.toString(8) : v));
}
function restore(json) {
  const f = new Vfs();
  let files = 0;
  const tree = JSON.parse(json, (k, v) => (k === 'm' ? parseInt(v, 8) : v));
  const rec = (path, n) => {
    for (const [name, child] of Object.entries(n.e)) {
      const p = Path.join(path, name);
      if (child.t === 'd') {
        f.mkdir(p, { mode: child.m });
        rec(p, child);
      } else if (child.t === 'f') {
        f.writeFile(p, child.d);
        f.chmod(p, child.m);
        files++;
      } else f.symlink(child.to, p);
      if (child.o) f.resolve(p, { follow: false }).node.owner = child.o;
    }
  };
  rec('/', tree);
  return { f, files };
}
{
  const snap = snapshot(fs);
  let h = 7n;
  for (const ch of snap) h = (h * 131n + BigInt(ch.charCodeAt(0))) % 1000000007n;
  say('snapshot bytes', snap.length, 'hash', h.toString());
  const { f: copy, files } = restore(snap);
  say('restored files', files, 'equal', snapshot(copy) === snap, 'tree lines', copy.tree('/').length);
  say('inode check', Inode.isInode(copy.root), Inode.isInode({}), copy.root instanceof DirNode, copy.root instanceof FileNode);
  try {
    new Inode('x', 'y', 0);
  } catch ({ message }) {
    say('abstract inode', message);
  }
}

say('== proxy-mounted view ==');
{
  const view = new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key === 'symbol') return undefined;
        const p = '/' + key.replace(/__/g, '/');
        return fs.exists(p) ? fs.stat(p).type === 'file' ? fs.readFile(p) : fs.readdir(p) : undefined;
      },
      has: (_, key) => fs.exists('/' + String(key).replace(/__/g, '/')),
      set(_, key, value) {
        fs.writeFile('/' + key.replace(/__/g, '/'), value);
        return true;
      },
      deleteProperty(_, key) {
        try {
          fs.unlink('/' + key.replace(/__/g, '/'));
          return true;
        } catch {
          return false;
        }
      },
    }
  );
  view.tmp__proxied = 'from proxy';
  say('proxy read', view.tmp__proxied, 'tmp' in view, 'nope' in view, view.srv);
  say('proxy delete', delete view.tmp__proxied, Reflect.deleteProperty(view, 'tmp__proxied'), view.tmp__proxied ?? 'gone');
  say('optional', view.home?.length, view.missing?.length ?? -1, fs.on?.('write', null)?.call?.(null) ?? 'no', typeof fs.nothing?.());
}

say('== async crawl ==');
async function* crawl(f, path) {
  const { node } = f.resolve(path, { follow: false });
  await null;
  yield { path, type: node.type };
  if (node.type === 'dir') for (const name of node) yield* crawl(f, Path.join(path, name));
}
async function checksums(f) {
  const out = [];
  for await (const { path, type } of crawl(f, '/home')) {
    if (type !== 'file') continue;
    const data = await Promise.resolve(f.readFile(path));
    let sum = 0;
    for (const ch of data) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
    out.push(`${Path.basename(path)}=${sum.toString(16)}`);
  }
  return out;
}
(async () => {
  const sums = await checksums(fs);
  say('checksums', sums);
  const results = await Promise.allSettled(
    ['/tmp/bob.log', '/srv/nope', '/loopa', '/current/README.md'].map(async (p) => fs.readFile(p).length)
  );
  say('settled', results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason.code)));
  const order = [];
  await Promise.all([
    (async () => {
      order.push('a1');
      await null;
      order.push('a2');
    })(),
    (async () => {
      order.push('b1');
      await Promise.resolve();
      await null;
      order.push('b2');
    })(),
    Promise.resolve().then(() => order.push('c')),
  ]);
  say('order', order.join(''));
  const firstFile = await Promise.any([
    Promise.reject(new FsError('ENOENT', '/x')),
    (async () => {
      await null;
      return fs.readFile('/srv/b.txt');
    })(),
  ]);
  say('any', firstFile);
  say('done');
})();
