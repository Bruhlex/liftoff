// a09: string processing

function templates() {
  const name = 'World';
  const n = 3;
  console.log(`Hello, ${name}! ${n} + ${n} = ${n + n}`);
  console.log(`nested ${`inner ${name.toLowerCase()}`} and ${n > 2 ? `big ${n}` : 'small'}`);
  const multi = `line1
  line2
line3`;
  console.log('multiline lines', multi.split('\n').length, JSON.stringify(multi));
  console.log(`escapes: \` \${notInterp} \\ \t|`);
  const obj = { toString: () => 'OBJ' };
  console.log(`object interp ${obj} ${[1, 2, 3]} ${null} ${undefined}`);
}

function tag(strings, ...values) {
  return strings.raw.map((s, i) => s + (i < values.length ? '[' + typeof values[i] + ':' + values[i] + ']' : '')).join('');
}

function html(strings, ...values) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += esc(values[i]) + strings[i + 1];
  return out;
}

function taggedTemplates() {
  const a = 5;
  const b = 'x';
  console.log(tag`a=${a} b=${b} sum=${a + 1}\n`);
  console.log(html`<p title="${'"quoted"'}">${'<script>&'}</p>`);
  function countStrings(strings) {
    return strings.length + ':' + Object.isFrozen(strings) + ':' + Array.isArray(strings.raw);
  }
  console.log('tag meta', countStrings`a${1}b${2}c`);
  const cache = [];
  function identity(s) {
    cache.push(s);
    return s;
  }
  for (let i = 0; i < 2; i++) identity`same`;
  console.log('template object cached', cache[0] === cache[1]);
}

function rawStrings() {
  console.log(String.raw`C:\new\table\x`);
  console.log(String.raw`sum ${1 + 1} \n stays`);
  console.log(String.raw({ raw: ['a', 'b', 'c'] }, 1, 2, 3));
  console.log('raw length', String.raw`\u0041`.length, '\u0041'.length);
}

function regexGroups() {
  const date = /(\d{4})-(\d{2})-(\d{2})/;
  const m = '2024-03-15 and 2025-12-01'.match(date);
  console.log('groups', m[0], m[1], m[2], m[3], 'index', m.index);
  const named = /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/g;
  const all = [...'2024-03-15 and 2025-12-01'.matchAll(named)];
  all.forEach((mm) => console.log('named', mm.groups.day + '/' + mm.groups.month + '/' + mm.groups.year, mm.index));
  console.log('replace named', '2024-03-15'.replace(/(?<y>\d+)-(?<m>\d+)-(?<d>\d+)/, '$<d>.$<m>.$<y>'));
  console.log('replace $1', 'John Smith'.replace(/(\w+)\s(\w+)/, '$2, $1'));
  const rx = /o/g;
  const found = [];
  let r;
  while ((r = rx.exec('foo boo zoo')) !== null) found.push(r.index + '@' + rx.lastIndex);
  console.log('exec loop', found.join(' '));
  console.log('test/flags', /^abc$/i.test('ABC'), /a.c/s.test('a\nc'), /a.c/.test('a\nc'), new RegExp('x+', 'gi').flags);
  console.log('lookaround', 'price: $42, cost: $7'.match(/(?<=\$)\d+/g).join(','), 'foobar foobaz'.replace(/foo(?!bar)/g, 'X'));
  console.log('sticky', (() => {
    const s = /\d/y;
    s.lastIndex = 2;
    return s.test('ab3') + ',' + s.test('ab3');
  })());
}

function replaceWithFunction() {
  const s = 'the quick brown fox jumps over the lazy dog';
  const title = s.replace(/\b\w/g, (c) => c.toUpperCase());
  console.log('title', title);
  const counts = {};
  s.replace(/[aeiou]/g, (v) => {
    counts[v] = (counts[v] || 0) + 1;
    return v;
  });
  console.log('vowels', JSON.stringify(counts));
  const camel = 'some-long_variable name'.replace(/[-_ ](\w)/g, (_, ch, off) => ch.toUpperCase());
  console.log('camel', camel);
  const snake = 'someLongVariableName'.replace(/[A-Z]/g, (c, off) => (off ? '_' : '') + c.toLowerCase());
  console.log('snake', snake);
  console.log('replaceAll', 'a.b.c.d'.replaceAll('.', '/'), 'aaa'.replaceAll(/a/g, (m, o) => o));
  const tpl = 'Hi {name}, you have {count} new {what}';
  const vars = { name: 'Eve', count: 3 };
  console.log(tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)));
}

function splitJoin() {
  const csv = 'name,age,city\nAnn,30,Paris\nBob,25,Berlin';
  const rows = csv.split('\n').map((line) => line.split(','));
  const [header, ...data] = rows;
  const objs = data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  console.log('csv', JSON.stringify(objs));
  console.log('split limit', 'a,b,c,d'.split(',', 2).join('|'));
  console.log('split regex', 'one1two22three333four'.split(/\d+/).join(' '));
  console.log('split capture', 'a1b2c'.split(/(\d)/).join(' '));
  console.log('split empty', 'abc'.split('').reverse().join(''));
  console.log('join types', [1, null, undefined, 'x', [2, 3]].join('-'));
}

function padAndTrim() {
  const rows = [
    ['apple', 1.5],
    ['kiwi', 12.25],
    ['watermelon', 100],
  ];
  rows.forEach(([n, p]) => console.log('|' + n.padEnd(12, '.') + p.toFixed(2).padStart(8) + '|'));
  console.log('hex pad', (255).toString(16).padStart(4, '0'), (5).toString(2).padStart(8, '0'));
  console.log('trim', JSON.stringify('  \t spaced \n '.trim()), JSON.stringify('  x '.trimStart()), JSON.stringify(' x  '.trimEnd()));
  console.log('repeat', '=-'.repeat(10));
  console.log('case', 'MiXeD'.toLowerCase(), 'MiXeD'.toUpperCase());
  console.log('search', 'hello world'.indexOf('o'), 'hello world'.lastIndexOf('o'), 'hello'.includes('ell'), 'hello'.startsWith('he'), 'hello'.endsWith('lo'));
  console.log('slice/substring', 'abcdef'.slice(-3), 'abcdef'.slice(1, -1), 'abcdef'.substring(4, 1), 'abcdef'.at(-2));
}

function unicode() {
  const s = 'a€😀é';
  console.log('length', s.length, [...s].length);
  console.log('codePointAt', s.codePointAt(0), s.codePointAt(1), s.codePointAt(2), s.codePointAt(3));
  console.log('charCodeAt surrogate', s.charCodeAt(2).toString(16), s.charCodeAt(3).toString(16));
  console.log('fromCodePoint', String.fromCodePoint(128512, 65, 0x20ac), String.fromCharCode(72, 105));
  console.log('code points', [...s].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '));
  const composed = 'e\u0301';
  console.log('normalize', composed.length, composed.normalize('NFC').length, composed.normalize('NFC') === 'é');
  console.log('unicode regex', /\u{1F600}/u.test(s), '😀'.match(/./gu).length, '😀'.match(/./g).length);
  console.log('escape', '\u{1F600}' === '😀', '\x41\u0042', encodeURIComponent('ä ö/€'));
  console.log('localeCompare basic', ['b', 'a', 'C'].sort().join(''), 'a' < 'b', 'B' < 'a');
}

function caesar(str, shift) {
  return str.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + shift + 26) % 26) + base);
  });
}

function wordFreq(text) {
  const freq = new Map();
  for (const w of text.toLowerCase().match(/[a-z']+/g)) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5);
}

function algorithms() {
  const enc = caesar('Hello, World!', 3);
  console.log('caesar', enc, caesar(enc, -3));
  console.log('palindromes', ['racecar', 'A man, a plan, a canal: Panama', 'nope'].map((p) => {
    const c = p.toLowerCase().replace(/[^a-z]/g, '');
    return c === [...c].reverse().join('');
  }).join(','));
  console.log('freq', JSON.stringify(wordFreq("the cat and the hat and the bat, it's the cat")));
  const rle = (s) => s.replace(/(.)\1*/g, (m, c) => m.length + c);
  console.log('rle', rle('aaabccddddde'));
}

templates();
taggedTemplates();
rawStrings();
regexGroups();
replaceWithFunction();
splitJoin();
padAndTrim();
unicode();
algorithms();
console.log('done a09');
