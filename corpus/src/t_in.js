"use strict";

const PI = 3.14159;
let counter = 0;

const factorial = (n) => (n <= 1 ? 1 : n * factorial(n - 1));
const makeCounter = () => { let c = 0; return () => ++c; };
const sum = (start = 0, ...nums) => nums.reduce((a, n) => a + n, start);

function collatz(n) {
  let steps = 0;
  while (n !== 1) { n = n % 2 === 0 ? n / 2 : 3 * n + 1; steps++; }
  return steps;
}

function primesUpTo(limit) {
  const sieve = new Array(limit + 1).fill(true);
  sieve[0] = sieve[1] = false;
  for (let i = 2; i * i <= limit; i++)
    if (sieve[i]) for (let j = i * i; j <= limit; j += i) sieve[j] = false;
  const out = [];
  for (let i = 2; i <= limit; i++) if (sieve[i]) out.push(i);
  return out;
}

const inventory = [
  { name: "Widget", price: 9.99, tags: ["a", "b"] },
  { name: "Gadget", price: 19.5, tags: ["b", "c"] },
  { name: "Gizmo", price: 4.25, tags: ["a", "c"] },
];

const cheapTotal = (items) =>
  items.filter((it) => it.price < 15).reduce((a, it) => a + it.price, 0);

function uniqueTags(items) {
  const set = new Set();
  for (const it of items) for (const t of it.tags) set.add(t);
  return [...set].sort();
}

function wordFreq(text) {
  const freq = new Map();
  for (const w of text.toLowerCase().split(/\s+/)) freq.set(w, (freq.get(w) || 0) + 1);
  return freq;
}

class Shape {
  constructor(name) { this.name = name; }
  area() { return 0; }
  describe() { return `${this.name}: ${this.area().toFixed(2)}`; }
}
class Rectangle extends Shape {
  constructor(w, h) { super("Rect"); this.w = w; this.h = h; }
  area() { return this.w * this.h; }
  get perimeter() { return 2 * (this.w + this.h); }
}
class Circle extends Shape {
  constructor(r) { super("Circle"); this.r = r; }
  area() { return PI * this.r * this.r; }
}

function grade(score) {
  switch (true) {
    case score >= 90: return "A";
    case score >= 80: return "B";
    case score >= 70: return "C";
    default: return "F";
  }
}

function safeParse(json) {
  try { return JSON.parse(json); }
  catch { return { error: true }; }
  finally { counter++; }
}

function main() {
  const out = [];
  out.push("factorial(6) = " + factorial(6));
  const c = makeCounter(); c(); c();
  out.push("counter = " + c());
  out.push("sum = " + sum(10, 1, 2, 3, 4));
  out.push("collatz(27) = " + collatz(27));
  out.push("primes = " + primesUpTo(30).join(","));
  out.push("cheapTotal = " + Math.round(cheapTotal(inventory) * 100) / 100);
  out.push("tags = " + uniqueTags(inventory).join(","));
  out.push("freq(the) = " + wordFreq("the cat sat on the mat the end").get("the"));

  const shapes = [new Rectangle(3, 4), new Circle(2)];
  for (const s of shapes) out.push(s.describe());
  out.push("perimeter = " + shapes[0].perimeter);

  out.push("grade(85) = " + grade(85));
  out.push("parse = " + JSON.stringify(safeParse("{bad}")) + " calls=" + counter);

  const config = { debug: false, level: 3 };
  const keys = [];
  for (const k in config) keys.push(k + "=" + config[k]);
  out.push("config = " + keys.join(";"));

  return out.join("\n");
}

console.log(main());