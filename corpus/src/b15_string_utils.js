// String utilities: Levenshtein, LCS, KMP, RLE, base64, caesar/vigenere
'use strict';

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function lcs(a, b) {
  const dp = [];
  for (let i = 0; i <= a.length; i++) dp.push(new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  let i = a.length, j = b.length;
  const out = [];
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push(a[i - 1]);
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return out.reverse().join('');
}

function kmpTable(pattern) {
  const table = new Array(pattern.length).fill(0);
  let k = 0;
  for (let i = 1; i < pattern.length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = table[k - 1];
    if (pattern[i] === pattern[k]) k++;
    table[i] = k;
  }
  return table;
}

function kmpSearch(text, pattern) {
  if (!pattern) return [];
  const table = kmpTable(pattern);
  const hits = [];
  let comparisons = 0;
  for (let i = 0, k = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== pattern[k]) {
      comparisons++;
      k = table[k - 1];
    }
    comparisons++;
    if (text[i] === pattern[k]) k++;
    if (k === pattern.length) {
      hits.push(i - k + 1);
      k = table[k - 1];
    }
  }
  return { hits, comparisons };
}

function rleEncode(s) {
  let out = '';
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j < s.length && s[j] === s[i] && j - i < 9) j++;
    out += (j - i) + s[i];
    i = j;
  }
  return out;
}

function rleDecode(s) {
  return s.replace(/(\d)(.)/gs, (_, n, ch) => ch.repeat(Number(n)));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(str) {
  const bytes = [];
  for (const ch of str) {
    let cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return bytes;
}

function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp, n;
    if (b < 0x80) { cp = b; n = 1; }
    else if (b >> 5 === 6) { cp = b & 31; n = 2; }
    else if (b >> 4 === 14) { cp = b & 15; n = 3; }
    else { cp = b & 7; n = 4; }
    for (let k = 1; k < n; k++) cp = (cp << 6) | (bytes[i + k] & 63);
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

function base64Encode(str) {
  const bytes = utf8Bytes(str);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.slice(i, i + 3);
    const triple = (a << 16) | (b << 8) | c;
    out += B64[(triple >>> 18) & 63] + B64[(triple >>> 12) & 63];
    out += i + 1 < bytes.length ? B64[(triple >>> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[triple & 63] : '=';
  }
  return out;
}

function base64Decode(s) {
  const clean = s.replace(/=+$/, '');
  const bytes = [];
  let buffer = 0, bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error(`invalid base64 char '${ch}'`);
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return utf8Decode(bytes);
}

function shiftChar(ch, k) {
  const code = ch.charCodeAt(0);
  if (code >= 65 && code <= 90) return String.fromCharCode(((code - 65 + k) % 26 + 26) % 26 + 65);
  if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + k) % 26 + 26) % 26 + 97);
  return ch;
}

const caesar = (s, k = 3) => [...s].map((c) => shiftChar(c, k)).join('');

function vigenere(text, key, decrypt = false) {
  let j = 0;
  let out = '';
  for (const ch of text) {
    if (/[a-z]/i.test(ch)) {
      const k = key.toLowerCase().charCodeAt(j++ % key.length) - 97;
      out += shiftChar(ch, decrypt ? -k : k);
    } else {
      out += ch;
    }
  }
  return out;
}

function letterFrequencies(text) {
  const freq = new Map();
  for (const ch of text.toLowerCase()) {
    if (ch >= 'a' && ch <= 'z') freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  return [...freq].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
}

function crackCaesar(cipher) {
  const english = 'etaoinshrdlu';
  let best = { shift: 0, score: -Infinity, text: '' };
  for (let s = 0; s < 26; s++) {
    const cand = caesar(cipher, -s);
    let score = 0;
    for (const ch of cand.toLowerCase()) {
      const idx = english.indexOf(ch);
      if (idx >= 0) score += english.length - idx;
    }
    if (score > best.score) best = { shift: s, score, text: cand };
  }
  return best;
}

class StringBuilder {
  #parts = [];
  #length = 0;
  append(...xs) {
    for (const x of xs) {
      const s = String(x);
      this.#parts.push(s);
      this.#length += s.length;
    }
    return this;
  }
  get length() { return this.#length; }
  toString() { return this.#parts.join(''); }
}

function wordWrap(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const toCase = {
  camel: (s) => s.toLowerCase().replace(/[-_ ]+(.)/g, (_, c) => c.toUpperCase()),
  snake: (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[- ]+/g, '_').toLowerCase(),
  kebab: (s) => toCase.snake(s).replace(/_/g, '-'),
  title: (s) => s.replace(/\b\w/g, (c) => c.toUpperCase()),
};

function isPalindrome(s) {
  const t = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  let i = 0, j = t.length - 1;
  while (i < j) if (t[i++] !== t[j--]) return false;
  return true;
}

function longestPalSubstring(s) {
  let best = [0, 0];
  const expand = (l, r) => {
    while (l >= 0 && r < s.length && s[l] === s[r]) { l--; r++; }
    return [l + 1, r];
  };
  for (let i = 0; i < s.length; i++) {
    for (const [l, r] of [expand(i, i), expand(i, i + 1)]) {
      if (r - l > best[1] - best[0]) best = [l, r];
    }
  }
  return s.slice(...best);
}

function hl(strings, ...vals) {
  return strings.raw.map((s, i) => s + (i < vals.length ? `<${vals[i]}>` : '')).join('');
}

function main() {
  console.log('--- levenshtein ---');
  const pairs = [['kitten', 'sitting'], ['flaw', 'lawn'], ['', 'abc'], ['same', 'same'], ['intention', 'execution']];
  for (const [a, b] of pairs) console.log(`lev(${a || '""'}, ${b}) = ${levenshtein(a, b)}`);
  const dict = ['apple', 'apply', 'ample', 'maple', 'angle', 'apple pie'];
  const query = 'appel';
  const ranked = dict.map((w) => ({ w, d: levenshtein(query, w) })).sort((x, y) => x.d - y.d || x.w.localeCompare(y.w));
  console.log('suggestions for', query, ranked.slice(0, 3).map(({ w, d }) => `${w}(${d})`).join(' '));

  console.log('--- lcs ---');
  for (const [a, b] of [['ABCBDAB', 'BDCABA'], ['AGGTAB', 'GXTXAYB'], ['dynamic', 'programming']]) {
    const r = lcs(a, b);
    console.log(`lcs(${a},${b}) = "${r}" len ${r.length}`);
  }

  console.log('--- kmp ---');
  console.log('table', kmpTable('ABABCABAB').join(','));
  const text = 'abracadabra abracadabra cadabra';
  for (const p of ['abra', 'cad', 'zzz', 'a']) {
    const { hits, comparisons } = kmpSearch(text, p);
    console.log(`search "${p}": ${hits.length} hits at [${hits}] cmp=${comparisons}`);
  }

  console.log('--- rle ---');
  for (const s of ['aaabccddddd', 'WWWWWWWWWWWWBWWWWWWWWWWWWBBB', 'abc', '']) {
    const enc = rleEncode(s);
    console.log(`"${s}" -> "${enc}" -> ok=${rleDecode(enc) === s}`);
  }

  console.log('--- base64 ---');
  const b64tests = ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'Hello, World!', 'Grüße €', 'emoji \u{1F600}!'];
  for (const s of b64tests) {
    const e = base64Encode(s);
    const d = base64Decode(e);
    console.log(`${JSON.stringify(s)} -> ${e} ${d === s ? 'OK' : 'MISMATCH'}`);
  }
  try {
    base64Decode('ab$d');
  } catch (err) {
    console.log('decode error:', err.message);
  }

  console.log('--- ciphers ---');
  const plain = 'The quick brown fox jumps over the lazy dog, again and again.';
  const c13 = caesar(plain, 13);
  console.log('rot13', c13);
  console.log('rot13 twice ok', caesar(c13, 13) === plain);
  const secret = caesar(plain, 7);
  const cracked = crackCaesar(secret);
  console.log(`cracked shift=${cracked.shift} ok=${cracked.text === plain}`);
  const v = vigenere('Attack at dawn!', 'LEMON');
  console.log('vigenere', v, '->', vigenere(v, 'LEMON', true));
  console.log('freq top5', letterFrequencies(plain).slice(0, 5).map(([c, n]) => c + n).join(' '));

  console.log('--- builder & wrap ---');
  const sb = new StringBuilder();
  sb.append('a', 1, true).append(null, undefined, [1, 2]);
  console.log('builder', sb.toString(), sb.length);
  const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
  wordWrap(lorem, 28).forEach((l, i) => console.log(`${String(i + 1).padStart(2)}| ${l.padEnd(28)} |`));

  console.log('--- cases ---');
  for (const s of ['hello world', 'someVariableName', 'kebab-case-here']) {
    const out = {};
    for (const k in toCase) out[k] = toCase[k](s);
    console.log(JSON.stringify(out));
  }

  console.log('--- palindromes ---');
  for (const s of ['A man, a plan, a canal: Panama', 'racecar', 'hello', 'forgeeksskeegfor', 'babad']) {
    console.log(`${s}: pal=${isPalindrome(s)} longest="${longestPalSubstring(s)}"`);
  }
  console.log(hl`raw\t${'x'} and ${42}\n`);
  const counts = [...'mississippi'].reduce((acc, ch) => ((acc[ch] ??= 0), acc[ch]++, acc), {});
  console.log('counts', JSON.stringify(counts));
}

main();
