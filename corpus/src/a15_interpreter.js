// a15: tokenizer + recursive-descent parser + evaluator for arithmetic expressions

const TokenType = Object.freeze({
  NUM: 'NUM',
  IDENT: 'IDENT',
  OP: 'OP',
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  COMMA: 'COMMA',
  ASSIGN: 'ASSIGN',
  EOF: 'EOF',
});

class Token {
  constructor(type, value, pos) {
    this.type = type;
    this.value = value;
    this.pos = pos;
  }
  toString() {
    return this.type + (this.value !== undefined ? '(' + this.value + ')' : '');
  }
}

class LexError extends Error {
  constructor(msg, pos) {
    super(msg + ' at ' + pos);
    this.name = 'LexError';
  }
}

class ParseError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ParseError';
  }
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  const isAlpha = (c) => /[A-Za-z_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i;
      while (i < src.length && (isDigit(src[i]) || src[i] === '.')) i++;
      tokens.push(new Token(TokenType.NUM, parseFloat(src.slice(start, i)), start));
      continue;
    }
    if (isAlpha(c)) {
      const start = i;
      while (i < src.length && (isAlpha(src[i]) || isDigit(src[i]))) i++;
      tokens.push(new Token(TokenType.IDENT, src.slice(start, i), start));
      continue;
    }
    if (c === '*' && src[i + 1] === '*') {
      tokens.push(new Token(TokenType.OP, '**', i));
      i += 2;
      continue;
    }
    switch (c) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case '^':
        tokens.push(new Token(TokenType.OP, c === '^' ? '**' : c, i));
        break;
      case '(':
        tokens.push(new Token(TokenType.LPAREN, undefined, i));
        break;
      case ')':
        tokens.push(new Token(TokenType.RPAREN, undefined, i));
        break;
      case ',':
        tokens.push(new Token(TokenType.COMMA, undefined, i));
        break;
      case '=':
        tokens.push(new Token(TokenType.ASSIGN, undefined, i));
        break;
      default:
        throw new LexError('unexpected char ' + JSON.stringify(c), i);
    }
    i++;
  }
  tokens.push(new Token(TokenType.EOF, undefined, i));
  return tokens;
}

// Grammar:
// stmt   := IDENT '=' expr | expr
// expr   := term (('+'|'-') term)*
// term   := unary (('*'|'/'|'%') unary)*
// unary  := '-' unary | '+' unary | power
// power  := call ('**' unary)?
// call   := IDENT '(' args ')' | primary
// primary:= NUM | IDENT | '(' expr ')'
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() {
    return this.tokens[this.pos];
  }
  next() {
    return this.tokens[this.pos++];
  }
  expect(type, value) {
    const t = this.next();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ParseError('expected ' + type + ' but got ' + t + ' at ' + t.pos);
    }
    return t;
  }
  parseStatement() {
    const t = this.peek();
    if (t.type === TokenType.IDENT && this.tokens[this.pos + 1].type === TokenType.ASSIGN) {
      this.pos += 2;
      const value = this.parseExpr();
      this.expect(TokenType.EOF);
      return { type: 'assign', name: t.value, value };
    }
    const e = this.parseExpr();
    this.expect(TokenType.EOF);
    return e;
  }
  parseExpr() {
    let left = this.parseTerm();
    while (this.peek().type === TokenType.OP && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      left = { type: 'bin', op, left, right: this.parseTerm() };
    }
    return left;
  }
  parseTerm() {
    let left = this.parseUnary();
    while (this.peek().type === TokenType.OP && '*/%'.includes(this.peek().value) && this.peek().value !== '**') {
      const op = this.next().value;
      left = { type: 'bin', op, left, right: this.parseUnary() };
    }
    return left;
  }
  parseUnary() {
    const t = this.peek();
    if (t.type === TokenType.OP && (t.value === '-' || t.value === '+')) {
      this.next();
      return { type: 'unary', op: t.value, arg: this.parseUnary() };
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parseCall();
    if (this.peek().type === TokenType.OP && this.peek().value === '**') {
      this.next();
      return { type: 'bin', op: '**', left: base, right: this.parseUnary() };
    }
    return base;
  }
  parseCall() {
    const t = this.peek();
    if (t.type === TokenType.IDENT && this.tokens[this.pos + 1].type === TokenType.LPAREN) {
      this.pos += 2;
      const args = [];
      if (this.peek().type !== TokenType.RPAREN) {
        do {
          args.push(this.parseExpr());
        } while (this.peek().type === TokenType.COMMA && this.next());
      }
      this.expect(TokenType.RPAREN);
      return { type: 'call', name: t.value, args };
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.next();
    switch (t.type) {
      case TokenType.NUM:
        return { type: 'num', value: t.value };
      case TokenType.IDENT:
        return { type: 'var', name: t.value };
      case TokenType.LPAREN: {
        const e = this.parseExpr();
        this.expect(TokenType.RPAREN);
        return e;
      }
      default:
        throw new ParseError('unexpected ' + t + ' at ' + t.pos);
    }
  }
}

class Interpreter {
  constructor() {
    this.env = new Map([
      ['pi', Math.PI],
      ['e', Math.E],
    ]);
    this.funcs = {
      max: (...a) => Math.max(...a),
      min: (...a) => Math.min(...a),
      sqrt: Math.sqrt,
      abs: Math.abs,
      floor: Math.floor,
      avg: (...a) => a.reduce((s, x) => s + x, 0) / a.length,
      fact: (n) => (n <= 1 ? 1 : n * this.funcs.fact(n - 1)),
    };
    this.steps = 0;
  }
  eval(node) {
    this.steps++;
    switch (node.type) {
      case 'num':
        return node.value;
      case 'var':
        if (!this.env.has(node.name)) throw new ReferenceError('undefined variable ' + node.name);
        return this.env.get(node.name);
      case 'unary': {
        const v = this.eval(node.arg);
        return node.op === '-' ? -v : +v;
      }
      case 'bin': {
        const l = this.eval(node.left);
        const r = this.eval(node.right);
        switch (node.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/':
            if (r === 0) throw new RangeError('division by zero');
            return l / r;
          case '%': return l % r;
          case '**': return l ** r;
        }
        throw new Error('bad op ' + node.op);
      }
      case 'call': {
        const f = this.funcs[node.name];
        if (typeof f !== 'function') throw new ReferenceError('unknown function ' + node.name);
        return f(...node.args.map((a) => this.eval(a)));
      }
      case 'assign': {
        const v = this.eval(node.value);
        this.env.set(node.name, v);
        return v;
      }
    }
    throw new Error('unknown node ' + node.type);
  }
}

function show(node) {
  switch (node.type) {
    case 'num': return String(node.value);
    case 'var': return node.name;
    case 'unary': return '(' + node.op + show(node.arg) + ')';
    case 'bin': return '(' + show(node.left) + ' ' + node.op + ' ' + show(node.right) + ')';
    case 'call': return node.name + '(' + node.args.map(show).join(', ') + ')';
    case 'assign': return node.name + ' := ' + show(node.value);
  }
}

function toRPN(node) {
  switch (node.type) {
    case 'num': return [String(node.value)];
    case 'var': return [node.name];
    case 'unary': return [...toRPN(node.arg), 'neg'.slice(0, node.op === '-' ? 3 : 0) || 'pos'];
    case 'bin': return [...toRPN(node.left), ...toRPN(node.right), node.op];
    case 'call': return [...node.args.flatMap(toRPN), node.name + '/' + node.args.length];
    case 'assign': return [...toRPN(node.value), '->' + node.name];
  }
}

function constantFold(node) {
  if (node.type === 'bin') {
    const l = constantFold(node.left), r = constantFold(node.right);
    if (l.type === 'num' && r.type === 'num' && !(node.op === '/' && r.value === 0)) {
      return { type: 'num', value: new Interpreter().eval({ type: 'bin', op: node.op, left: l, right: r }) };
    }
    return { ...node, left: l, right: r };
  }
  if (node.type === 'unary') {
    const a = constantFold(node.arg);
    return a.type === 'num' ? { type: 'num', value: node.op === '-' ? -a.value : a.value } : { ...node, arg: a };
  }
  if (node.type === 'call') return { ...node, args: node.args.map(constantFold) };
  if (node.type === 'assign') return { ...node, value: constantFold(node.value) };
  return node;
}

function run(programs) {
  const interp = new Interpreter();
  for (const src of programs) {
    try {
      const tokens = tokenize(src);
      const ast = new Parser(tokens).parseStatement();
      const val = interp.eval(ast);
      console.log(src.padEnd(34), '=>', Number.isInteger(val) ? val : val.toFixed(6));
      console.log('   ast:', show(ast));
      console.log('   rpn:', toRPN(ast).join(' '), '| folded:', show(constantFold(ast)));
    } catch (e) {
      console.log(src.padEnd(34), '!!', e.name + ': ' + e.message);
    }
  }
  console.log('total eval steps', interp.steps);
  console.log('env', [...interp.env].map(([k, v]) => k + '=' + (Number.isInteger(v) ? v : v.toFixed(3))).join(' '));
}

console.log('tokens:', tokenize('3 + 4.5*(x - 2) ** 2').map(String).join(' '));
run([
  '1 + 2 * 3',
  '(1 + 2) * 3',
  '2 ** 3 ** 2',
  '-2 ** 2',
  '10 % 4 + 7 / 2',
  'x = 5',
  'y = x * 2 + 1',
  'x * y - 3',
  'max(1, x, y, 3) + min(4, 2)',
  'sqrt(16) + abs(-3) + floor(2.7)',
  'avg(1, 2, 3, 4) * fact(5)',
  'r = 2',
  'pi * r ^ 2',
  '--3 + +4',
  '1 / 0',
  'z + 1',
  'foo(1)',
  '3 + * 4',
  '(1 + 2',
  '2 $ 3',
  'e ** 1',
]);
console.log('done a15');
