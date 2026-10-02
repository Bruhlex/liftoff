'use strict';
// Deterministic fake browser environment for Node.
//   node -r ./env/browser-shim.js prog.js
// Installs window/self/navigator/screen/document/location/history/storage/performance/crypto/
// matchMedia/requestAnimationFrame/Event classes on globalThis. Everything is deterministic:
// performance.now() advances by a fixed step per call, crypto.getRandomValues uses a seeded PRNG,
// canvas toDataURL() is a hash of the drawing calls. Date and Math.random are NOT touched.
// All shim functions report 'function X() { [native code] }' through Function.prototype.toString.
(function installBrowserShim(G) {
  if (G.__browserShimInstalled) return;
  Object.defineProperty(G, '__browserShimInstalled', { value: true, enumerable: false, configurable: true });

  const S = Symbol('shim-internal');
  const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, enumerable: false, configurable: true });
  const priv = (o) => o[S];

  // ------------------------------------------------------------------ native-looking toString
  const nativeFns = new WeakSet();
  const origToString = Function.prototype.toString;
  const toStringHolder = {
    toString() {
      if (typeof this === 'function' && nativeFns.has(this)) return 'function ' + this.name + '() { [native code] }';
      return origToString.call(this);
    },
  };
  nativeFns.add(toStringHolder.toString);
  Object.defineProperty(Function.prototype, 'toString', { value: toStringHolder.toString, writable: true, enumerable: false, configurable: true });
  function markNative(fn) { if (typeof fn === 'function') nativeFns.add(fn); return fn; }
  // Mark every function/accessor on an object (and optionally make accessors/methods enumerable like WebIDL).
  function nativize(obj, idlEnumerable) {
    for (const key of Reflect.ownKeys(obj)) {
      const d = Object.getOwnPropertyDescriptor(obj, key);
      if (!d) continue;
      if (typeof d.value === 'function') markNative(d.value);
      if (d.get) markNative(d.get);
      if (d.set) markNative(d.set);
      if (idlEnumerable && key !== 'constructor' && typeof key === 'string' && d.configurable && !d.enumerable) {
        d.enumerable = true;
        Object.defineProperty(obj, key, d);
      }
    }
    return obj;
  }
  function nativizeClass(C, tag, idlEnumerable = true) {
    markNative(C);
    nativize(C.prototype, idlEnumerable);
    nativize(C, false);
    if (tag) Object.defineProperty(C.prototype, Symbol.toStringTag, { value: tag, configurable: true });
    return C;
  }

  // ------------------------------------------------------------------ helpers
  function fnv1a(str, seed) {
    let h = (seed === undefined ? 0x811c9dc5 : seed) >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function makePrng(seed) {
    let a = seed >>> 0;
    return function next32() { // mulberry32
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
  }
  const origBtoa = typeof G.btoa === 'function' ? G.btoa : null;
  const origAtob = typeof G.atob === 'function' ? G.atob : null;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function shimBtoa(s) {
    s = String(s);
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new DOMException('Invalid character', 'InvalidCharacterError');
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function shimAtob(s) {
    s = String(s).replace(/[\t\n\f\r ]/g, '').replace(/=+$/, '');
    let out = '', buf = 0, bits = 0;
    for (const ch of s) {
      const v = B64.indexOf(ch);
      if (v < 0) throw new DOMException('Invalid character', 'InvalidCharacterError');
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 255); }
    }
    return out;
  }
  const btoa = origBtoa || shimBtoa;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  function define(name, value) {
    Object.defineProperty(G, name, { value, writable: true, enumerable: true, configurable: true });
  }

  // ------------------------------------------------------------------ deterministic clocks
  const PERF_STEP = 0.5;
  let perfTicks = 0;
  const perfPeek = () => perfTicks * PERF_STEP;
  const perfNow = () => (++perfTicks) * PERF_STEP;
  const TIME_ORIGIN = 1735689600000; // 2025-01-01T00:00:00Z (used only for cookie expiry checks)

  // ------------------------------------------------------------------ Events
  class Event {
    #type; #bubbles; #cancelable; #composed; #defaultPrevented = false; #stop = false; #stopImmediate = false;
    #target = null; #currentTarget = null; #phase = 0; #timeStamp; #dispatching = false;
    constructor(type, init) {
      if (arguments.length === 0) throw new TypeError("Failed to construct 'Event': 1 argument required, but only 0 present.");
      init = init || {};
      this.#type = String(type);
      this.#bubbles = !!init.bubbles;
      this.#cancelable = !!init.cancelable;
      this.#composed = !!init.composed;
      this.#timeStamp = perfPeek();
      Object.defineProperty(this, 'isTrusted', { get: markNative(function isTrusted() { return false; }), enumerable: true, configurable: false });
    }
    get type() { return this.#type; }
    get bubbles() { return this.#bubbles; }
    get cancelable() { return this.#cancelable; }
    get composed() { return this.#composed; }
    get defaultPrevented() { return this.#defaultPrevented; }
    get target() { return this.#target; }
    get srcElement() { return this.#target; }
    get currentTarget() { return this.#currentTarget; }
    get eventPhase() { return this.#phase; }
    get timeStamp() { return this.#timeStamp; }
    get cancelBubble() { return this.#stop; }
    set cancelBubble(v) { if (v) this.#stop = true; }
    get returnValue() { return !this.#defaultPrevented; }
    set returnValue(v) { if (!v) this.preventDefault(); }
    preventDefault() { const p = this[S]; if (this.#cancelable && !(p && p.passive)) this.#defaultPrevented = true; }
    stopPropagation() { this.#stop = true; }
    stopImmediatePropagation() { this.#stop = true; this.#stopImmediate = true; }
    composedPath() { return this.#dispatching ? priv(this).path.slice() : []; }
    initEvent(type, bubbles, cancelable) {
      if (this.#dispatching) return;
      this.#type = String(type); this.#bubbles = !!bubbles; this.#cancelable = !!cancelable;
    }
    static _dispatch(ev, target) {
      if (ev.#dispatching) throw new DOMException('The event is already being dispatched.', 'InvalidStateError');
      const path = [];
      for (let n = target; n; n = parentForEvent(n)) path.push(n);
      hidden(ev, S, { path, passive: false });
      ev.#dispatching = true; ev.#target = target; ev.#stop = false; ev.#stopImmediate = false;
      const invoke = (node, phase, captureOnly, bubbleOnly) => {
        ev.#currentTarget = node; ev.#phase = phase;
        const list = listenersOf(node, ev.#type).slice();
        for (const l of list) {
          if (ev.#stopImmediate) break;
          if (l.removed) continue;
          if (captureOnly && !l.capture) continue;
          if (bubbleOnly && l.capture) continue;
          if (l.once) removeListenerRecord(node, ev.#type, l);
          priv(ev).passive = l.passive;
          try {
            if (typeof l.callback === 'function') l.callback.call(node, ev);
            else if (l.callback && typeof l.callback.handleEvent === 'function') l.callback.handleEvent(ev);
          } catch (err) { console.error('Uncaught', err && err.message ? err.message : err); }
          priv(ev).passive = false;
        }
        const handler = !captureOnly ? node['on' + ev.#type] : null;
        if (typeof handler === 'function' && !ev.#stopImmediate) {
          try { const r = handler.call(node, ev); if (r === false) ev.preventDefault(); } catch (err) { console.error('Uncaught', err && err.message ? err.message : err); }
        }
      };
      for (let i = path.length - 1; i >= 1 && !ev.#stop; i--) invoke(path[i], 1, true, false);
      if (!ev.#stop) {
        invoke(target, 2, true, false);
        if (!ev.#stop) invoke(target, 2, false, true);
      }
      if (ev.#bubbles) for (let i = 1; i < path.length && !ev.#stop; i++) invoke(path[i], 3, false, true);
      ev.#dispatching = false; ev.#phase = 0; ev.#currentTarget = null;
      return !ev.#defaultPrevented;
    }
  }
  Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;
  const dispatchImpl = Event._dispatch;
  delete Event._dispatch;

  class CustomEvent extends Event {
    #detail;
    constructor(type, init) { super(type, init); this.#detail = init && init.detail !== undefined ? init.detail : null; }
    get detail() { return this.#detail; }
    initCustomEvent(type, bubbles, cancelable, detail) { this.initEvent(type, bubbles, cancelable); this.#detail = detail; }
  }
  class UIEvent extends Event {
    #detail; #view;
    constructor(type, init) { super(type, init); init = init || {}; this.#detail = init.detail | 0; this.#view = init.view || null; }
    get detail() { return this.#detail; }
    get view() { return this.#view; }
    get which() { return 0; }
  }
  const MOD_KEYS = ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'];
  class MouseEvent extends UIEvent {
    #i;
    constructor(type, init) {
      super(type, init); init = init || {};
      const n = (k) => Number(init[k]) || 0;
      this.#i = { clientX: n('clientX'), clientY: n('clientY'), screenX: n('screenX'), screenY: n('screenY'),
        movementX: n('movementX'), movementY: n('movementY'), button: n('button'), buttons: n('buttons'), relatedTarget: init.relatedTarget || null };
      for (const k of MOD_KEYS) this.#i[k] = !!init[k];
    }
    get clientX() { return this.#i.clientX; } get clientY() { return this.#i.clientY; }
    get x() { return this.#i.clientX; } get y() { return this.#i.clientY; }
    get pageX() { return this.#i.clientX; } get pageY() { return this.#i.clientY; }
    get offsetX() { return this.#i.clientX; } get offsetY() { return this.#i.clientY; }
    get screenX() { return this.#i.screenX; } get screenY() { return this.#i.screenY; }
    get movementX() { return this.#i.movementX; } get movementY() { return this.#i.movementY; }
    get button() { return this.#i.button; } get buttons() { return this.#i.buttons; }
    get relatedTarget() { return this.#i.relatedTarget; }
    get ctrlKey() { return this.#i.ctrlKey; } get shiftKey() { return this.#i.shiftKey; }
    get altKey() { return this.#i.altKey; } get metaKey() { return this.#i.metaKey; }
    getModifierState(k) { return !!this.#i[{ Control: 'ctrlKey', Shift: 'shiftKey', Alt: 'altKey', Meta: 'metaKey' }[k]]; }
  }
  class PointerEvent extends MouseEvent {
    #p;
    constructor(type, init) {
      super(type, init); init = init || {};
      this.#p = { pointerId: init.pointerId | 0, pointerType: init.pointerType || '', pressure: Number(init.pressure) || 0,
        width: init.width === undefined ? 1 : Number(init.width), height: init.height === undefined ? 1 : Number(init.height), isPrimary: !!init.isPrimary };
    }
    get pointerId() { return this.#p.pointerId; } get pointerType() { return this.#p.pointerType; }
    get pressure() { return this.#p.pressure; } get width() { return this.#p.width; }
    get height() { return this.#p.height; } get isPrimary() { return this.#p.isPrimary; }
  }
  class WheelEvent extends MouseEvent {
    #d;
    constructor(type, init) { super(type, init); init = init || {}; this.#d = [Number(init.deltaX) || 0, Number(init.deltaY) || 0, Number(init.deltaZ) || 0, init.deltaMode | 0]; }
    get deltaX() { return this.#d[0]; } get deltaY() { return this.#d[1]; } get deltaZ() { return this.#d[2]; } get deltaMode() { return this.#d[3]; }
  }
  class KeyboardEvent extends UIEvent {
    #k;
    constructor(type, init) {
      super(type, init); init = init || {};
      this.#k = { key: init.key === undefined ? '' : String(init.key), code: init.code === undefined ? '' : String(init.code),
        location: init.location | 0, repeat: !!init.repeat, isComposing: !!init.isComposing, keyCode: init.keyCode | 0 };
      for (const k of MOD_KEYS) this.#k[k] = !!init[k];
    }
    get key() { return this.#k.key; } get code() { return this.#k.code; } get location() { return this.#k.location; }
    get repeat() { return this.#k.repeat; } get isComposing() { return this.#k.isComposing; }
    get keyCode() { return this.#k.keyCode; } get charCode() { return 0; }
    get ctrlKey() { return this.#k.ctrlKey; } get shiftKey() { return this.#k.shiftKey; }
    get altKey() { return this.#k.altKey; } get metaKey() { return this.#k.metaKey; }
    getModifierState(k) { return !!this.#k[{ Control: 'ctrlKey', Shift: 'shiftKey', Alt: 'altKey', Meta: 'metaKey' }[k]]; }
  }
  class FocusEvent extends UIEvent {
    #r;
    constructor(type, init) { super(type, init); this.#r = (init && init.relatedTarget) || null; }
    get relatedTarget() { return this.#r; }
  }
  class PopStateEvent extends Event {
    #state;
    constructor(type, init) { super(type, init); this.#state = init && init.state !== undefined ? init.state : null; }
    get state() { return this.#state; }
  }
  class StorageEvent extends Event {
    #i;
    constructor(type, init) { super(type, init); init = init || {}; this.#i = { key: init.key ?? null, oldValue: init.oldValue ?? null, newValue: init.newValue ?? null, url: init.url || '', storageArea: init.storageArea || null }; }
    get key() { return this.#i.key; } get oldValue() { return this.#i.oldValue; } get newValue() { return this.#i.newValue; }
    get url() { return this.#i.url; } get storageArea() { return this.#i.storageArea; }
  }

  // listener storage lives outside the objects
  const listenerMap = new WeakMap();
  function listenersOf(target, type) {
    const m = listenerMap.get(target);
    return (m && m.get(type)) || [];
  }
  function removeListenerRecord(target, type, rec) {
    const m = listenerMap.get(target);
    const arr = m && m.get(type);
    if (!arr) return;
    const i = arr.indexOf(rec);
    if (i >= 0) { arr.splice(i, 1); rec.removed = true; }
  }
  function parentForEvent(n) {
    if (n === G) return null;
    if (n instanceof Document) return G;
    if (n instanceof Node) return priv(n).parent;
    return null;
  }
  const flagOpt = (o, k) => (typeof o === 'boolean' ? (k === 'capture' ? o : false) : !!(o && o[k]));

  class EventTarget {
    addEventListener(type, callback, options) {
      if (callback == null) return;
      const target = this == null ? G : this;
      let m = listenerMap.get(target);
      if (!m) { m = new Map(); listenerMap.set(target, m); }
      type = String(type);
      if (!m.has(type)) m.set(type, []);
      const arr = m.get(type);
      const capture = flagOpt(options, 'capture');
      if (arr.some((l) => l.callback === callback && l.capture === capture)) return;
      arr.push({ callback, capture, once: flagOpt(options, 'once'), passive: flagOpt(options, 'passive'), removed: false });
    }
    removeEventListener(type, callback, options) {
      const target = this == null ? G : this;
      const capture = flagOpt(options, 'capture');
      const rec = listenersOf(target, String(type)).find((l) => l.callback === callback && l.capture === capture);
      if (rec) removeListenerRecord(target, String(type), rec);
    }
    dispatchEvent(event) {
      if (!(event instanceof Event)) throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
      return dispatchImpl(event, this == null ? G : this);
    }
  }

  // ------------------------------------------------------------------ DOM nodes
  const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const TAG_CLASS = { div: 'HTMLDivElement', span: 'HTMLSpanElement', canvas: 'HTMLCanvasElement', input: 'HTMLInputElement',
    a: 'HTMLAnchorElement', button: 'HTMLButtonElement', p: 'HTMLParagraphElement', ul: 'HTMLUListElement', ol: 'HTMLOListElement',
    li: 'HTMLLIElement', form: 'HTMLFormElement', img: 'HTMLImageElement', script: 'HTMLScriptElement', body: 'HTMLBodyElement',
    head: 'HTMLHeadElement', html: 'HTMLHtmlElement', meta: 'HTMLMetaElement', title: 'HTMLTitleElement', iframe: 'HTMLIFrameElement',
    table: 'HTMLTableElement', tr: 'HTMLTableRowElement', td: 'HTMLTableCellElement', label: 'HTMLLabelElement', select: 'HTMLSelectElement',
    option: 'HTMLOptionElement', textarea: 'HTMLTextAreaElement', style: 'HTMLStyleElement', h1: 'HTMLHeadingElement', h2: 'HTMLHeadingElement', h3: 'HTMLHeadingElement' };
  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');

  function listLike(arr, extra) {
    const out = arr.slice();
    hidden(out, 'item', markNative(function item(i) { return out[i] === undefined ? null : out[i]; }));
    if (extra) extra(out);
    return out;
  }

  class Node extends EventTarget {
    constructor(nodeType, nodeName, doc) {
      super();
      hidden(this, S, { nodeType, nodeName, parent: null, kids: [], doc: doc || null });
    }
    get nodeType() { return priv(this).nodeType; }
    get nodeName() { return priv(this).nodeName; }
    get ownerDocument() { return this instanceof Document ? null : priv(this).doc || G.document || null; }
    get parentNode() { return priv(this).parent; }
    get parentElement() { const p = priv(this).parent; return p instanceof Element ? p : null; }
    get childNodes() { return listLike(priv(this).kids); }
    get firstChild() { return priv(this).kids[0] || null; }
    get lastChild() { const k = priv(this).kids; return k[k.length - 1] || null; }
    get nextSibling() { const p = priv(this).parent; if (!p) return null; const k = priv(p).kids; return k[k.indexOf(this) + 1] || null; }
    get previousSibling() { const p = priv(this).parent; if (!p) return null; const k = priv(p).kids; return k[k.indexOf(this) - 1] || null; }
    get isConnected() { let n = this; while (priv(n).parent) n = priv(n).parent; return n instanceof Document; }
    get nodeValue() { return null; }
    get textContent() { return priv(this).kids.filter((k) => k.nodeType === 1 || k.nodeType === 3).map((k) => k.textContent).join(''); }
    set textContent(v) {
      for (const k of priv(this).kids) priv(k).parent = null;
      priv(this).kids = [];
      v = v == null ? '' : String(v);
      if (v !== '') this.appendChild(new Text(v));
    }
    hasChildNodes() { return priv(this).kids.length > 0; }
    contains(other) { for (let n = other; n; n = priv(n).parent) if (n === this) return true; return false; }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, ref) {
      if (!(node instanceof Node)) throw new TypeError("Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.");
      if (node.contains(this)) throw new DOMException('The new child element contains the parent.', 'HierarchyRequestError');
      if (ref != null && priv(ref).parent !== this) throw new DOMException('The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError');
      const nodes = node instanceof DocumentFragment ? priv(node).kids.slice() : [node];
      for (const n of nodes) {
        const p = priv(n).parent;
        if (p) priv(p).kids.splice(priv(p).kids.indexOf(n), 1);
        if (node instanceof DocumentFragment) priv(n).parent = null;
      }
      if (node instanceof DocumentFragment) priv(node).kids = [];
      const kids = priv(this).kids;
      let idx = ref == null ? kids.length : kids.indexOf(ref);
      for (const n of nodes) { kids.splice(idx++, 0, n); priv(n).parent = this; }
      return node;
    }
    removeChild(child) {
      if (!(child instanceof Node) || priv(child).parent !== this) throw new DOMException('The node to be removed is not a child of this node.', 'NotFoundError');
      const kids = priv(this).kids;
      kids.splice(kids.indexOf(child), 1);
      priv(child).parent = null;
      return child;
    }
    replaceChild(newChild, oldChild) {
      if (!(oldChild instanceof Node) || priv(oldChild).parent !== this) throw new DOMException('The node to be replaced is not a child of this node.', 'NotFoundError');
      if (newChild === oldChild) return oldChild;
      this.insertBefore(newChild, oldChild);
      return this.removeChild(oldChild);
    }
    cloneNode(deep) {
      let c;
      if (this instanceof Text) c = new Text(this.data);
      else if (this instanceof DocumentFragment) c = new DocumentFragment();
      else if (this instanceof Element) {
        c = createElementImpl(this.localName);
        for (const [k, v] of priv(this).attrs) priv(c).attrs.set(k, v);
        Object.assign(c.style, this.style);
      } else throw new DOMException('Not supported', 'NotSupportedError');
      if (deep) for (const k of priv(this).kids) c.appendChild(k.cloneNode(true));
      return c;
    }
    getRootNode() { let n = this; while (priv(n).parent) n = priv(n).parent; return n; }
  }
  Node.ELEMENT_NODE = 1; Node.TEXT_NODE = 3; Node.COMMENT_NODE = 8; Node.DOCUMENT_NODE = 9; Node.DOCUMENT_FRAGMENT_NODE = 11;

  class CharacterData extends Node {
    get data() { return priv(this).data; }
    set data(v) { priv(this).data = String(v); }
    get nodeValue() { return priv(this).data; }
    set nodeValue(v) { priv(this).data = String(v); }
    get textContent() { return priv(this).data; }
    set textContent(v) { priv(this).data = v == null ? '' : String(v); }
    get length() { return priv(this).data.length; }
    appendData(s) { priv(this).data += String(s); }
    remove() { const p = priv(this).parent; if (p) p.removeChild(this); }
  }
  class Text extends CharacterData {
    constructor(data) { super(3, '#text'); priv(this).data = data === undefined ? '' : String(data); }
    get wholeText() { return priv(this).data; }
  }
  class Comment extends CharacterData {
    constructor(data) { super(8, '#comment'); priv(this).data = data === undefined ? '' : String(data); }
  }

  // --- tiny selector engine: tag, #id, .class, [attr], [attr=v], [attr^=v], [attr$=v], [attr*=v], :first-child, :last-child, ' ' and '>'
  function parseCompound(src) {
    const c = { tag: null, id: null, classes: [], attrs: [], pseudo: [] };
    let m = /^([a-zA-Z][\w-]*|\*)/.exec(src);
    let rest = src;
    if (m) { if (m[1] !== '*') c.tag = m[1].toLowerCase(); rest = src.slice(m[0].length); }
    const re = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([\^$*~]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:([\w-]+)/y;
    while (rest.length) {
      re.lastIndex = 0;
      m = re.exec(rest);
      if (!m) throw new DOMException("'" + src + "' is not a valid selector.", 'SyntaxError');
      if (m[1]) c.id = m[1];
      else if (m[2]) c.classes.push(m[2]);
      else if (m[3]) c.attrs.push({ name: m[3].toLowerCase(), op: m[4] || null, value: m[5] ?? m[6] ?? m[7] ?? null });
      else c.pseudo.push(m[8]);
      rest = rest.slice(m[0].length);
    }
    return c;
  }
  const selectorCache = new Map();
  function parseSelector(sel) {
    if (selectorCache.has(sel)) return selectorCache.get(sel);
    const groups = String(sel).split(',').map((g) => {
      const toks = g.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
      if (!toks[0]) throw new DOMException("'" + sel + "' is not a valid selector.", 'SyntaxError');
      const parts = [];
      let comb = ' ';
      for (const t of toks) {
        if (t === '>') { comb = '>'; continue; }
        parts.push({ comb, c: parseCompound(t) });
        comb = ' ';
      }
      return parts;
    });
    selectorCache.set(sel, groups);
    return groups;
  }
  function matchCompound(el, c) {
    if (!(el instanceof Element)) return false;
    if (c.tag && el.localName !== c.tag) return false;
    if (c.id && el.getAttribute('id') !== c.id) return false;
    if (c.classes.length) { const cl = (el.getAttribute('class') || '').split(/\s+/); if (!c.classes.every((x) => cl.includes(x))) return false; }
    for (const a of c.attrs) {
      const v = el.getAttribute(a.name);
      if (v === null) return false;
      if (a.op === '=' && v !== a.value) return false;
      if (a.op === '^=' && !v.startsWith(a.value)) return false;
      if (a.op === '$=' && !v.endsWith(a.value)) return false;
      if (a.op === '*=' && !v.includes(a.value)) return false;
      if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
    }
    for (const p of c.pseudo) {
      const parent = priv(el).parent;
      const sibs = parent ? priv(parent).kids.filter((k) => k instanceof Element) : [el];
      if (p === 'first-child' && sibs[0] !== el) return false;
      else if (p === 'last-child' && sibs[sibs.length - 1] !== el) return false;
      else if (p !== 'first-child' && p !== 'last-child') throw new DOMException("':" + p + "' is not supported by the shim.", 'SyntaxError');
    }
    return true;
  }
  function matchParts(el, parts, i) {
    if (!matchCompound(el, parts[i].c)) return false;
    if (i === 0) return true;
    let p = priv(el).parent;
    if (parts[i].comb === '>') return p instanceof Element && matchParts(p, parts, i - 1);
    for (; p instanceof Element; p = priv(p).parent) if (matchParts(p, parts, i - 1)) return true;
    return false;
  }
  const matchesSelector = (el, sel) => parseSelector(sel).some((parts) => matchParts(el, parts, parts.length - 1));
  function descendants(root, out = []) {
    for (const k of priv(root).kids) { if (k instanceof Element) { out.push(k); descendants(k, out); } }
    return out;
  }
  const ParentNodeMixin = {
    get children() { return listLike(priv(this).kids.filter((k) => k instanceof Element), (out) => hidden(out, 'namedItem', markNative(function namedItem(n) { return out.find((e) => e.id === n || e.getAttribute('name') === n) || null; }))); },
    get childElementCount() { return priv(this).kids.filter((k) => k instanceof Element).length; },
    get firstElementChild() { return priv(this).kids.find((k) => k instanceof Element) || null; },
    get lastElementChild() { const e = priv(this).kids.filter((k) => k instanceof Element); return e[e.length - 1] || null; },
    querySelector(sel) { parseSelector(sel); return descendants(this).find((e) => matchesSelector(e, sel)) || null; },
    querySelectorAll(sel) { parseSelector(sel); return listLike(descendants(this).filter((e) => matchesSelector(e, sel))); },
    getElementsByTagName(tag) { tag = String(tag).toLowerCase(); return listLike(descendants(this).filter((e) => tag === '*' || e.localName === tag)); },
    getElementsByClassName(names) { const want = String(names).trim().split(/\s+/); return listLike(descendants(this).filter((e) => want.every((w) => e.classList.contains(w)))); },
    append(...nodes) { for (const n of nodes) this.appendChild(n instanceof Node ? n : new Text(String(n))); },
    prepend(...nodes) { const first = priv(this).kids[0] || null; for (const n of nodes) this.insertBefore(n instanceof Node ? n : new Text(String(n)), first); },
    replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); },
  };
  function mixin(C, src) { Object.defineProperties(C.prototype, Object.getOwnPropertyDescriptors(src)); }

  class DocumentFragment extends Node {
    constructor() { super(11, '#document-fragment'); }
  }
  mixin(DocumentFragment, ParentNodeMixin);

  class CSSStyleDeclaration {
    get cssText() {
      return Object.keys(this).filter((k) => typeof this[k] === 'string' && this[k] !== '').map((k) => kebab(k) + ': ' + this[k] + ';').join(' ');
    }
    set cssText(v) {
      for (const k of Object.keys(this)) delete this[k];
      for (const decl of String(v).split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) this[camel(decl.slice(0, i).trim())] = decl.slice(i + 1).trim();
      }
    }
    get length() { return Object.keys(this).filter((k) => this[k] !== '').length; }
    setProperty(name, value) { this[camel(String(name))] = value == null ? '' : String(value); }
    getPropertyValue(name) { const v = this[camel(String(name))]; return typeof v === 'string' ? v : ''; }
    removeProperty(name) { const k = camel(String(name)); const v = this.getPropertyValue(name); delete this[k]; return v; }
    item(i) { return kebab(Object.keys(this)[i] || ''); }
  }

  class DOMTokenList {
    constructor(el) { hidden(this, S, { el }); }
    #tokens() { return (priv(this).el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
    #write(t) { priv(this).el.setAttribute('class', t.join(' ')); }
    get length() { return this.#tokens().length; }
    get value() { return priv(this).el.getAttribute('class') || ''; }
    item(i) { return this.#tokens()[i] ?? null; }
    contains(t) { return this.#tokens().includes(String(t)); }
    add(...ts) { const cur = this.#tokens(); for (const t of ts) if (!cur.includes(t)) cur.push(String(t)); this.#write(cur); }
    remove(...ts) { this.#write(this.#tokens().filter((x) => !ts.includes(x))); }
    toggle(t, force) {
      const has = this.contains(t);
      const want = force === undefined ? !has : !!force;
      if (want && !has) this.add(t); else if (!want && has) this.remove(t);
      return want;
    }
    replace(a, b) { const cur = this.#tokens(); const i = cur.indexOf(a); if (i < 0) return false; cur[i] = b; this.#write(cur); return true; }
    toString() { return this.value; }
    forEach(cb, thisArg) { this.#tokens().forEach((t, i) => cb.call(thisArg, t, i, this)); }
    [Symbol.iterator]() { return this.#tokens()[Symbol.iterator](); }
  }

  class Element extends Node {
    constructor(tag) {
      super(1, String(tag).toUpperCase());
      Object.assign(priv(this), { tag: String(tag).toLowerCase(), attrs: new Map(), style: new CSSStyleDeclaration(), value: null, checked: false });
    }
    get tagName() { return priv(this).nodeName; }
    get localName() { return priv(this).tag; }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get classList() { return new DOMTokenList(this); }
    get attributes() { return listLike([...priv(this).attrs].map(([name, value]) => ({ name, value, localName: name, nodeType: 2 })), (out) => hidden(out, 'getNamedItem', markNative(function getNamedItem(n) { return out.find((a) => a.name === n) || null; }))); }
    setAttribute(name, value) { priv(this).attrs.set(String(name).toLowerCase(), String(value)); }
    getAttribute(name) { const v = priv(this).attrs.get(String(name).toLowerCase()); return v === undefined ? null : v; }
    hasAttribute(name) { return priv(this).attrs.has(String(name).toLowerCase()); }
    removeAttribute(name) { priv(this).attrs.delete(String(name).toLowerCase()); }
    toggleAttribute(name, force) { const has = this.hasAttribute(name); const want = force === undefined ? !has : !!force; if (want && !has) this.setAttribute(name, ''); if (!want) this.removeAttribute(name); return want; }
    getAttributeNames() { return [...priv(this).attrs.keys()]; }
    hasAttributes() { return priv(this).attrs.size > 0; }
    get nextElementSibling() { for (let n = this.nextSibling; n; n = n.nextSibling) if (n instanceof Element) return n; return null; }
    get previousElementSibling() { for (let n = this.previousSibling; n; n = n.previousSibling) if (n instanceof Element) return n; return null; }
    matches(sel) { return matchesSelector(this, sel); }
    closest(sel) { for (let n = this; n instanceof Element; n = priv(n).parent) if (matchesSelector(n, sel)) return n; return null; }
    remove() { const p = priv(this).parent; if (p) p.removeChild(this); }
    get outerHTML() {
      const attrs = [...priv(this).attrs].map(([k, v]) => ' ' + k + '="' + escAttr(v) + '"').join('');
      const open = '<' + priv(this).tag + attrs + '>';
      return VOID_TAGS.has(priv(this).tag) ? open : open + this.innerHTML + '</' + priv(this).tag + '>';
    }
    get innerHTML() {
      return priv(this).kids.map((k) => (k instanceof Element ? k.outerHTML : k instanceof Text ? escText(k.data) : k instanceof Comment ? '<!--' + k.data + '-->' : '')).join('');
    }
    set innerHTML(v) {
      v = String(v);
      if (/[<>]/.test(v)) throw new DOMException('browser-shim: innerHTML with markup is not supported', 'NotSupportedError');
      this.textContent = v;
    }
    getBoundingClientRect() {
      const st = priv(this).style;
      const x = parseFloat(st.left) || 0, y = parseFloat(st.top) || 0;
      const w = parseFloat(st.width) || (this.localName === 'canvas' ? this.width : 0), h = parseFloat(st.height) || (this.localName === 'canvas' ? this.height : 0);
      const r = { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
      r.toJSON = markNative(function toJSON() { return { x, y, width: w, height: h, top: y, right: x + w, bottom: y + h, left: x }; });
      return r;
    }
  }
  mixin(Element, ParentNodeMixin);

  class HTMLElement extends Element {
    get style() { return priv(this).style; }
    set style(v) { priv(this).style.cssText = v; }
    get dataset() {
      const el = this;
      return new Proxy({}, {
        get: (t, p) => (typeof p === 'string' ? el.getAttribute('data-' + kebab(p)) ?? undefined : undefined),
        set: (t, p, v) => { el.setAttribute('data-' + kebab(String(p)), v); return true; },
        has: (t, p) => typeof p === 'string' && el.hasAttribute('data-' + kebab(p)),
        deleteProperty: (t, p) => { el.removeAttribute('data-' + kebab(String(p))); return true; },
        ownKeys: () => el.getAttributeNames().filter((n) => n.startsWith('data-')).map((n) => camel(n.slice(5))),
        getOwnPropertyDescriptor: (t, p) => (el.hasAttribute('data-' + kebab(String(p))) ? { value: el.getAttribute('data-' + kebab(String(p))), writable: true, enumerable: true, configurable: true } : undefined),
      });
    }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { this.toggleAttribute('hidden', !!v); }
    get title() { return this.getAttribute('title') || ''; }
    set title(v) { this.setAttribute('title', v); }
    get tabIndex() { const v = this.getAttribute('tabindex'); return v === null ? (['a', 'button', 'input', 'select', 'textarea'].includes(this.localName) ? 0 : -1) : parseInt(v, 10); }
    get innerText() { return this.textContent; }
    set innerText(v) { this.textContent = v; }
    get value() { const p = priv(this); return p.value !== null ? p.value : this.getAttribute('value') || ''; }
    set value(v) { priv(this).value = String(v); }
    get checked() { return priv(this).checked; }
    set checked(v) { priv(this).checked = !!v; }
    get type() { return this.getAttribute('type') || (this.localName === 'button' ? 'submit' : this.localName === 'input' ? 'text' : ''); }
    get name() { return this.getAttribute('name') || ''; }
    get href() { const h = this.getAttribute('href'); return h === null ? '' : new URL(h, G.location.href).href; }
    get src() { const h = this.getAttribute('src'); return h === null ? '' : new URL(h, G.location.href).href; }
    get offsetWidth() { return Math.round(this.getBoundingClientRect().width); }
    get offsetHeight() { return Math.round(this.getBoundingClientRect().height); }
    get clientWidth() { return this.offsetWidth; }
    get clientHeight() { return this.offsetHeight; }
    get offsetParent() { return this.parentElement; }
    focus() { if (G.document) priv(G.document).active = this; this.dispatchEvent(new FocusEvent('focus')); }
    blur() { if (G.document && priv(G.document).active === this) priv(G.document).active = null; this.dispatchEvent(new FocusEvent('blur')); }
    click() { this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })); }
    get [Symbol.toStringTag]() { return TAG_CLASS[priv(this).tag] || 'HTMLElement'; }
  }

  // ------------------------------------------------------------------ canvas
  const CANVAS_STATE_KEYS = ['fillStyle', 'strokeStyle', 'font', 'textBaseline', 'textAlign', 'globalAlpha', 'globalCompositeOperation', 'lineWidth', 'lineCap', 'lineJoin', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'direction', 'filter', 'imageSmoothingEnabled'];
  const CANVAS_DEFAULTS = { fillStyle: '#000000', strokeStyle: '#000000', font: '10px sans-serif', textBaseline: 'alphabetic', textAlign: 'start', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0, direction: 'ltr', filter: 'none', imageSmoothingEnabled: true };
  function normColor(v) {
    if (typeof v !== 'string') return v;
    const s = v.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return '#' + m[1].split('').map((c) => c + c).join('');
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
    if (m) return '#' + [m[1], m[2], m[3]].map((x) => Math.min(255, +x).toString(16).padStart(2, '0')).join('');
    const named = { red: '#ff0000', green: '#008000', blue: '#0000ff', black: '#000000', white: '#ffffff', yellow: '#ffff00', orange: '#ffa500' };
    return named[s] || s;
  }
  class CanvasGradient {
    constructor(ctx, desc) { hidden(this, S, { ctx, desc, stops: [] }); }
    addColorStop(offset, color) {
      if (!(offset >= 0 && offset <= 1)) throw new DOMException('The provided value (' + offset + ') is outside the range (0.0, 1.0).', 'IndexSizeError');
      priv(this).stops.push(offset + ':' + normColor(color));
    }
  }
  class TextMetrics {
    constructor(width, size) {
      const w = width;
      Object.defineProperties(this, {
        width: { value: w, enumerable: true }, actualBoundingBoxLeft: { value: 0, enumerable: true },
        actualBoundingBoxRight: { value: w, enumerable: true }, actualBoundingBoxAscent: { value: Math.round(size * 0.72 * 100) / 100, enumerable: true },
        actualBoundingBoxDescent: { value: Math.round(size * 0.21 * 100) / 100, enumerable: true }, fontBoundingBoxAscent: { value: Math.round(size * 0.9), enumerable: true },
        fontBoundingBoxDescent: { value: Math.round(size * 0.23), enumerable: true },
      });
    }
  }
  class ImageData {
    constructor(a, b, c) {
      let data, w, h;
      if (a instanceof Uint8ClampedArray) { data = a; w = b; h = c || a.length / 4 / b; } else { w = a; h = b; data = new Uint8ClampedArray(w * h * 4); }
      Object.defineProperties(this, { data: { value: data, enumerable: true }, width: { value: w, enumerable: true }, height: { value: h, enumerable: true }, colorSpace: { value: 'srgb', enumerable: true } });
    }
  }
  function canvasMix(ctx, op, args) {
    const p = priv(ctx);
    const st = CANVAS_STATE_KEYS.map((k) => { const v = p.state[k]; return v instanceof CanvasGradient ? 'grad(' + priv(v).desc + ';' + priv(v).stops.join(',') + ')' : String(v); }).join('|');
    const a = Array.prototype.map.call(args, (x) => (typeof x === 'number' ? (Math.round(x * 1000) / 1000).toString() : x && typeof x === 'object' ? '[obj]' : String(x))).join(',');
    const rec = op + '(' + a + ')#' + st + '#' + p.transform.join(',');
    p.canvas[S].h1 = fnv1a(rec, p.canvas[S].h1);
    p.canvas[S].h2 = Math.imul((p.canvas[S].h2 ^ fnv1a(rec, 0x9e3779b9)) >>> 0, 0x85ebca6b) >>> 0;
    p.canvas[S].ops++;
  }
  function fontSize(font) { const m = /(\d+(?:\.\d+)?)px/.exec(font); return m ? parseFloat(m[1]) : 10; }
  function measure(text, font) {
    const size = fontSize(font);
    const bold = /bold|[6-9]00/.test(font) ? 1.06 : 1;
    const mono = /mono/i.test(font);
    let w = 0;
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      w += mono ? 0.6 : c < 128 ? (ch === ' ' ? 0.28 : /[il.,:;!|']/.test(ch) ? 0.25 : /[mwMW@]/.test(ch) ? 0.85 : /[A-Z]/.test(ch) ? 0.66 : 0.52) : c > 0x1f000 ? 1.25 : 1.0;
    }
    return Math.round(w * size * bold * 1000) / 1000;
  }
  class CanvasRenderingContext2D {
    constructor(canvas) { hidden(this, S, { canvas, state: Object.assign({}, CANVAS_DEFAULTS), stack: [], transform: [1, 0, 0, 1, 0, 0] }); }
    get canvas() { return priv(this).canvas; }
    save() { const p = priv(this); p.stack.push([Object.assign({}, p.state), p.transform.slice()]); canvasMix(this, 'save', []); }
    restore() { const p = priv(this); const s = p.stack.pop(); if (s) { p.state = s[0]; p.transform = s[1]; } canvasMix(this, 'restore', []); }
    translate(x, y) { const t = priv(this).transform; t[4] += x; t[5] += y; }
    scale(x, y) { const t = priv(this).transform; t[0] *= x; t[3] *= y; }
    rotate(a) { const t = priv(this).transform; t[1] += Math.round(Math.sin(a) * 1e6) / 1e6; t[2] -= Math.round(Math.sin(a) * 1e6) / 1e6; }
    setTransform(a, b, c, d, e, f) { priv(this).transform = [a, b, c, d, e, f].map((x) => Number(x) || 0); }
    resetTransform() { priv(this).transform = [1, 0, 0, 1, 0, 0]; }
    getTransform() { const t = priv(this).transform; return { a: t[0], b: t[1], c: t[2], d: t[3], e: t[4], f: t[5], isIdentity: t.join() === '1,0,0,1,0,0' }; }
    createLinearGradient(x0, y0, x1, y1) { return new CanvasGradient(this, 'lin:' + [x0, y0, x1, y1].join(',')); }
    createRadialGradient(x0, y0, r0, x1, y1, r1) { return new CanvasGradient(this, 'rad:' + [x0, y0, r0, x1, y1, r1].join(',')); }
    createPattern() { return null; }
    measureText(text) { canvasMix(this, 'measureText', [text]); return new TextMetrics(measure(text, priv(this).state.font), fontSize(priv(this).state.font)); }
    isPointInPath(x, y) { const c = priv(this).canvas[S]; return ((c.h1 ^ Math.imul(x | 0, 31) ^ (y | 0)) & 1) === 1; }
    isPointInStroke(x, y) { const c = priv(this).canvas[S]; return ((c.h2 ^ Math.imul(y | 0, 17) ^ (x | 0)) & 3) === 0; }
    getImageData(sx, sy, sw, sh) {
      if (!sw || !sh) throw new DOMException('The source width is 0.', 'IndexSizeError');
      const c = priv(this).canvas[S];
      const img = new ImageData(Math.abs(sw), Math.abs(sh));
      if (c.ops === 0) return img;
      const rnd = makePrng(c.h1 ^ Math.imul(sx | 0, 73856093) ^ Math.imul(sy | 0, 19349663) ^ c.h2);
      for (let i = 0; i < img.data.length; i += 4) { const r = rnd(); img.data[i] = r & 255; img.data[i + 1] = (r >>> 8) & 255; img.data[i + 2] = (r >>> 16) & 255; img.data[i + 3] = 255; }
      return img;
    }
    createImageData(w, h) { return new ImageData(w instanceof ImageData ? w.width : w, w instanceof ImageData ? w.height : h); }
    putImageData(img, x, y) { let s = 0; for (let i = 0; i < img.data.length; i++) s = (s * 31 + img.data[i]) >>> 0; canvasMix(this, 'putImageData', [s, x, y]); }
    drawImage(img, ...rest) { canvasMix(this, 'drawImage', [img && img[S] ? img[S].h1 : 0].concat(rest)); }
    setLineDash(seg) { priv(this).dash = Array.from(seg); canvasMix(this, 'setLineDash', seg); }
    getLineDash() { return (priv(this).dash || []).slice(); }
    getContextAttributes() { return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false }; }
  }
  for (const k of CANVAS_STATE_KEYS) {
    Object.defineProperty(CanvasRenderingContext2D.prototype, k, {
      get() { return priv(this).state[k]; },
      set(v) {
        const st = priv(this).state;
        if (k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') st[k] = v instanceof CanvasGradient ? v : normColor(String(v));
        else if (typeof CANVAS_DEFAULTS[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) st[k] = n; } else if (typeof CANVAS_DEFAULTS[k] === 'boolean') st[k] = !!v;
        else st[k] = String(v);
      },
      configurable: true, enumerable: true,
    });
  }
  for (const op of ['fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'bezierCurveTo', 'quadraticCurveTo', 'fill', 'stroke', 'clip']) {
    const fn = { [op]() { canvasMix(this, op, arguments); } }[op];
    Object.defineProperty(CanvasRenderingContext2D.prototype, op, { value: fn, writable: true, configurable: true, enumerable: true });
  }

  // ------------------------------------------------------------------ WebGL
  const GL = { DEPTH_BUFFER_BIT: 0x100, STENCIL_BUFFER_BIT: 0x400, COLOR_BUFFER_BIT: 0x4000, TRIANGLES: 4, ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, FLOAT: 0x1406,
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, LOW_FLOAT: 0x8df0, MEDIUM_FLOAT: 0x8df1, HIGH_FLOAT: 0x8df2, LOW_INT: 0x8df3, MEDIUM_INT: 0x8df4, HIGH_INT: 0x8df5,
    VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02, SHADING_LANGUAGE_VERSION: 0x8b8c, MAX_TEXTURE_SIZE: 0x0d33, MAX_VIEWPORT_DIMS: 0x0d3a,
    MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_VERTEX_ATTRIBS: 0x8869, MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd, MAX_VARYING_VECTORS: 0x8dfc,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
    ALIASED_LINE_WIDTH_RANGE: 0x846e, ALIASED_POINT_SIZE_RANGE: 0x846d, RED_BITS: 0x0d52, GREEN_BITS: 0x0d53, BLUE_BITS: 0x0d54, ALPHA_BITS: 0x0d55, DEPTH_BITS: 0x0d56, STENCIL_BITS: 0x0d57,
    COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401 };
  const GL2 = { MAX_3D_TEXTURE_SIZE: 0x8073, MAX_SAMPLES: 0x8d57, MAX_DRAW_BUFFERS: 0x8824, MAX_COLOR_ATTACHMENTS: 0x8cdf, MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f };
  const GL_EXTENSIONS = ['ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_clip_control', 'EXT_color_buffer_half_float', 'EXT_depth_clamp', 'EXT_disjoint_timer_query',
    'EXT_float_blend', 'EXT_frag_depth', 'EXT_polygon_offset_clamp', 'EXT_shader_texture_lod', 'EXT_texture_compression_bptc', 'EXT_texture_compression_rgtc',
    'EXT_texture_filter_anisotropic', 'EXT_texture_mirror_clamp_to_edge', 'EXT_sRGB', 'KHR_parallel_shader_compile', 'OES_element_index_uint', 'OES_fbo_render_mipmap',
    'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object',
    'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders',
    'WEBGL_depth_texture', 'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_multi_draw', 'WEBGL_polygon_mode'];
  const UNMASKED_VENDOR = 'Google Inc. (Intel)';
  const UNMASKED_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  class WebGLShaderPrecisionFormat {
    constructor(a, b, c) { Object.defineProperties(this, { rangeMin: { value: a, enumerable: true }, rangeMax: { value: b, enumerable: true }, precision: { value: c, enumerable: true } }); }
  }
  class WebGLObject { constructor(kind, id) { hidden(this, S, { kind, id }); } }
  class WebGLRenderingContext {
    constructor(canvas, v2) { hidden(this, S, { canvas, v2: !!v2, ids: 0, draws: 0, h: 0x811c9dc5, clear: [0, 0, 0, 0] }); }
    get canvas() { return priv(this).canvas; }
    get drawingBufferWidth() { return priv(this).canvas.width; }
    get drawingBufferHeight() { return priv(this).canvas.height; }
    getParameter(p) {
      const v2 = priv(this).v2;
      switch (p) {
        case GL.VENDOR: return 'WebKit';
        case GL.RENDERER: return 'WebKit WebGL';
        case GL.VERSION: return v2 ? 'WebGL 2.0 (OpenGL ES 3.0 Chromium)' : 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
        case GL.SHADING_LANGUAGE_VERSION: return v2 ? 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)' : 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
        case 0x9245: return UNMASKED_VENDOR;
        case 0x9246: return UNMASKED_RENDERER;
        case GL.MAX_TEXTURE_SIZE: case GL.MAX_CUBE_MAP_TEXTURE_SIZE: case GL.MAX_RENDERBUFFER_SIZE: return 16384;
        case GL.MAX_VERTEX_ATTRIBS: case GL.MAX_TEXTURE_IMAGE_UNITS: case GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS: return 16;
        case GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return 32;
        case GL.MAX_VERTEX_UNIFORM_VECTORS: return 4096;
        case GL.MAX_FRAGMENT_UNIFORM_VECTORS: return 1024;
        case GL.MAX_VARYING_VECTORS: return 30;
        case GL.MAX_VIEWPORT_DIMS: return new Int32Array([32767, 32767]);
        case GL.ALIASED_LINE_WIDTH_RANGE: return new Float32Array([1, 1]);
        case GL.ALIASED_POINT_SIZE_RANGE: return new Float32Array([1, 1024]);
        case GL.RED_BITS: case GL.GREEN_BITS: case GL.BLUE_BITS: case GL.ALPHA_BITS: return 8;
        case GL.DEPTH_BITS: return 24;
        case GL.STENCIL_BITS: return 0;
        case 0x84fe: return 16; // MAX_TEXTURE_MAX_ANISOTROPY_EXT
      }
      if (v2) {
        switch (p) {
          case GL2.MAX_3D_TEXTURE_SIZE: return 2048;
          case GL2.MAX_SAMPLES: return 16;
          case GL2.MAX_DRAW_BUFFERS: case GL2.MAX_COLOR_ATTACHMENTS: return 8;
          case GL2.MAX_UNIFORM_BUFFER_BINDINGS: return 24;
        }
      }
      return null;
    }
    getSupportedExtensions() { return GL_EXTENSIONS.slice(); }
    getExtension(name) {
      if (!GL_EXTENSIONS.includes(name)) return null;
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
      if (name === 'EXT_texture_filter_anisotropic') return { TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe - 1, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe };
      if (name === 'WEBGL_lose_context') return { loseContext: markNative(function loseContext() {}), restoreContext: markNative(function restoreContext() {}) };
      return {};
    }
    getContextAttributes() { return { alpha: true, antialias: true, depth: true, desynchronized: false, failIfMajorPerformanceCaveat: false, powerPreference: 'default', premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false, xrCompatible: false }; }
    getShaderPrecisionFormat(shaderType, precisionType) {
      if (precisionType >= GL.LOW_INT) return new WebGLShaderPrecisionFormat(31, 30, 0);
      return new WebGLShaderPrecisionFormat(127, 127, 23);
    }
    isContextLost() { return false; }
    createBuffer() { return new WebGLObject('buffer', ++priv(this).ids); }
    createShader(t) { return new WebGLObject('shader' + t, ++priv(this).ids); }
    createProgram() { return new WebGLObject('program', ++priv(this).ids); }
    createTexture() { return new WebGLObject('texture', ++priv(this).ids); }
    shaderSource(sh, src) { priv(this).h = fnv1a(String(src), priv(this).h); }
    getShaderParameter() { return true; }
    getProgramParameter() { return true; }
    getShaderInfoLog() { return ''; }
    getProgramInfoLog() { return ''; }
    getAttribLocation(prog, name) { return fnv1a(String(name)) % 4; }
    getUniformLocation(prog, name) { return new WebGLObject('uniform:' + name, ++priv(this).ids); }
    bufferData(target, data) { let s = priv(this).h; if (data && data.length) for (let i = 0; i < data.length; i++) s = fnv1a(String(data[i]), s); priv(this).h = s; }
    clearColor(r, g, b, a) { priv(this).clear = [r, g, b, a]; priv(this).h = fnv1a('clear' + [r, g, b, a].join(), priv(this).h); }
    drawArrays(mode, first, count) { priv(this).draws++; priv(this).h = fnv1a('draw' + [mode, first, count].join(), priv(this).h); }
    readPixels(x, y, w, h, fmt, type, pixels) {
      const rnd = makePrng(priv(this).h ^ priv(this).draws);
      for (let i = 0; i < pixels.length; i++) pixels[i] = priv(this).draws ? rnd() & 255 : Math.round(priv(this).clear[i & 3] * 255);
    }
  }
  for (const op of ['bindBuffer', 'compileShader', 'attachShader', 'linkProgram', 'useProgram', 'enableVertexAttribArray', 'vertexAttribPointer', 'uniform1f', 'uniform2f', 'uniform4fv', 'clear', 'viewport', 'enable', 'disable', 'blendFunc', 'bindTexture', 'deleteBuffer', 'deleteShader', 'deleteProgram']) {
    const fn = { [op]() {} }[op];
    Object.defineProperty(WebGLRenderingContext.prototype, op, { value: fn, writable: true, configurable: true, enumerable: true });
  }
  for (const [k, v] of Object.entries(GL)) { WebGLRenderingContext[k] = v; Object.defineProperty(WebGLRenderingContext.prototype, k, { value: v, enumerable: true }); }
  class WebGL2RenderingContext extends WebGLRenderingContext {}
  for (const [k, v] of Object.entries(Object.assign({}, GL, GL2))) { WebGL2RenderingContext[k] = v; Object.defineProperty(WebGL2RenderingContext.prototype, k, { value: v, enumerable: true }); }

  class HTMLCanvasElement extends HTMLElement {
    constructor() { super('canvas'); Object.assign(priv(this), { ctx: null, ctxType: null, h1: 0x811c9dc5, h2: 0x2545f491, ops: 0 }); }
    get width() { const v = this.getAttribute('width'); return v === null ? 300 : parseInt(v, 10) || 0; }
    set width(v) { this.setAttribute('width', String(v >>> 0)); }
    get height() { const v = this.getAttribute('height'); return v === null ? 150 : parseInt(v, 10) || 0; }
    set height(v) { this.setAttribute('height', String(v >>> 0)); }
    getContext(type) {
      const p = priv(this);
      type = String(type);
      const kind = type === '2d' ? '2d' : type === 'webgl' || type === 'experimental-webgl' ? 'webgl' : type === 'webgl2' ? 'webgl2' : null;
      if (!kind) return null;
      if (p.ctx) return p.ctxType === kind ? p.ctx : null;
      p.ctxType = kind;
      p.ctx = kind === '2d' ? new CanvasRenderingContext2D(this) : kind === 'webgl' ? new WebGLRenderingContext(this, false) : new WebGL2RenderingContext(this, true);
      return p.ctx;
    }
    toDataURL(type) {
      const p = priv(this);
      type = type === 'image/jpeg' || type === 'image/webp' ? type : 'image/png';
      const w = this.width, h = this.height;
      const be32 = (n) => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      let bytes;
      if (type === 'image/png') bytes = '\x89PNG\r\n\x1a\n' + be32(13) + 'IHDR' + be32(w) + be32(h) + '\x08\x06\x00\x00\x00';
      else if (type === 'image/jpeg') bytes = '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00';
      else bytes = 'RIFF' + be32(w * h) + 'WEBPVP8 ';
      const rnd = makePrng(p.h1 ^ Math.imul(w, 2654435761) ^ h);
      const rnd2 = makePrng(p.h2 ^ p.ops);
      const n = p.ops === 0 ? 24 : 48 + (p.ops % 8) * 3;
      for (let i = 0; i < n; i++) bytes += String.fromCharCode(p.ops === 0 ? (i * 7) & 255 : (rnd() ^ rnd2()) & 255);
      bytes += be32(0) + 'IEND\xaeB`\x82';
      return 'data:' + type + ';base64,' + btoa(bytes);
    }
    toBlob(cb) { const url = this.toDataURL(); queueMicrotask(() => cb({ size: url.length, type: 'image/png' })); }
  }

  function createElementImpl(tag) {
    tag = String(tag).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new DOMException("Failed to execute 'createElement' on 'Document': The tag name provided ('" + tag + "') is not a valid name.", 'InvalidCharacterError');
    return tag === 'canvas' ? new HTMLCanvasElement() : new HTMLElement(tag);
  }

  // ------------------------------------------------------------------ location / history
  const START_URL = 'https://shop.example.com/products/list?page=2&sort=price&utm_source=newsletter#top';
  class Location {
    constructor(url) { hidden(this, S, { url: new URL(url) }); }
    get href() { return priv(this).url.href; }
    set href(v) { priv(this).url = new URL(String(v), priv(this).url); }
    get protocol() { return priv(this).url.protocol; }
    get host() { return priv(this).url.host; }
    get hostname() { return priv(this).url.hostname; }
    get port() { return priv(this).url.port; }
    get pathname() { return priv(this).url.pathname; }
    get search() { return priv(this).url.search; }
    get hash() { return priv(this).url.hash; }
    set hash(v) {
      const old = this.href;
      priv(this).url.hash = String(v);
      if (old !== this.href) queueMicrotask(() => G.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: old, newURL: this.href })));
    }
    get origin() { return priv(this).url.origin; }
    get ancestorOrigins() { return listLike([]); }
    assign(url) { this.href = url; }
    replace(url) { this.href = url; }
    reload() {}
    toString() { return this.href; }
  }
  class HashChangeEvent extends Event {
    #o; #n;
    constructor(type, init) { super(type, init); this.#o = (init && init.oldURL) || ''; this.#n = (init && init.newURL) || ''; }
    get oldURL() { return this.#o; }
    get newURL() { return this.#n; }
  }
  class History {
    constructor() { hidden(this, S, { entries: [{ url: 'https://shop.example.com/', state: null }, { url: START_URL, state: null }], index: 1, scroll: 'auto' }); }
    get length() { return priv(this).entries.length; }
    get state() { const e = priv(this).entries[priv(this).index]; return e.state === null ? null : structuredClone(e.state); }
    get scrollRestoration() { return priv(this).scroll; }
    set scrollRestoration(v) { if (v === 'auto' || v === 'manual') priv(this).scroll = v; }
    #resolve(url) {
      const cur = G.location.href;
      const next = url === undefined || url === null ? cur : new URL(String(url), cur).href;
      if (new URL(next).origin !== new URL(cur).origin) throw new DOMException("Failed to execute 'pushState' on 'History': A history state object with URL '" + next + "' cannot be created in a document with origin '" + new URL(cur).origin + "'.", 'SecurityError');
      return next;
    }
    pushState(state, title, url) {
      const p = priv(this);
      const next = this.#resolve(url);
      p.entries.splice(p.index + 1);
      p.entries.push({ url: next, state: state === undefined ? null : structuredClone(state) });
      p.index++;
      priv(G.location).url = new URL(next);
    }
    replaceState(state, title, url) {
      const p = priv(this);
      const next = this.#resolve(url);
      p.entries[p.index] = { url: next, state: state === undefined ? null : structuredClone(state) };
      priv(G.location).url = new URL(next);
    }
    go(delta) {
      const p = priv(this);
      delta = delta | 0;
      const target = p.index + delta;
      if (delta === 0 || target < 0 || target >= p.entries.length) return;
      p.index = target;
      const e = p.entries[target];
      priv(G.location).url = new URL(e.url);
      queueMicrotask(() => G.dispatchEvent(new PopStateEvent('popstate', { state: e.state === null ? null : structuredClone(e.state) })));
    }
    back() { this.go(-1); }
    forward() { this.go(1); }
  }

  // ------------------------------------------------------------------ storage
  class Storage {
    constructor() { hidden(this, S, new Map()); }
    get length() { return priv(this).size; }
    key(i) { const k = [...priv(this).keys()][i]; return k === undefined ? null : k; }
    getItem(k) { const v = priv(this).get(String(k)); return v === undefined ? null : v; }
    setItem(k, v) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'setItem' on 'Storage': 2 arguments required, but only " + arguments.length + ' present.');
      let size = 0;
      for (const [a, b] of priv(this)) size += a.length + b.length;
      if (size + String(k).length + String(v).length > 5 * 1024 * 1024) throw new DOMException("Failed to execute 'setItem' on 'Storage': Setting the value of '" + k + "' exceeded the quota.", 'QuotaExceededError');
      priv(this).set(String(k), String(v));
    }
    removeItem(k) { priv(this).delete(String(k)); }
    clear() { priv(this).clear(); }
  }

  // ------------------------------------------------------------------ document
  class Document extends Node {
    constructor() {
      super(9, '#document');
      Object.assign(priv(this), { cookies: new Map(), title: '', active: null });
    }
    get documentElement() { return priv(this).kids.find((k) => k instanceof Element) || null; }
    get head() { const h = this.documentElement; return h ? h.querySelector('head') : null; }
    get body() { const h = this.documentElement; return h ? h.querySelector('body') : null; }
    get title() { return priv(this).title; }
    set title(v) { priv(this).title = String(v); }
    get cookie() { return [...priv(this).cookies].map(([k, v]) => (k === '' ? v : k + '=' + v)).join('; '); }
    set cookie(str) {
      const parts = String(str).split(';');
      const first = parts.shift();
      const eq = first.indexOf('=');
      const name = eq < 0 ? '' : first.slice(0, eq).trim();
      const value = eq < 0 ? first.trim() : first.slice(eq + 1).trim();
      let expired = false;
      for (const attr of parts) {
        const i = attr.indexOf('=');
        const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
        const val = i < 0 ? '' : attr.slice(i + 1).trim();
        if (key === 'max-age') { const n = parseInt(val, 10); if (!Number.isNaN(n)) expired = n <= 0; }
        if (key === 'expires') { const t = Date.parse(val); if (!Number.isNaN(t)) expired = t <= TIME_ORIGIN; }
      }
      if (expired) priv(this).cookies.delete(name);
      else priv(this).cookies.set(name, value);
    }
    get referrer() { return 'https://www.google.com/'; }
    get URL() { return G.location.href; }
    get documentURI() { return G.location.href; }
    get domain() { return G.location.hostname; }
    get location() { return G.location; }
    get readyState() { return 'complete'; }
    get visibilityState() { return 'visible'; }
    get hidden() { return false; }
    get characterSet() { return 'UTF-8'; }
    get charset() { return 'UTF-8'; }
    get contentType() { return 'text/html'; }
    get compatMode() { return 'CSS1Compat'; }
    get defaultView() { return G; }
    get currentScript() { return null; }
    get activeElement() { return priv(this).active || this.body; }
    get fonts() { return fontFaceSet; }
    get lastModified() { return '01/01/2025 00:00:00'; }
    hasFocus() { return true; }
    createElement(tag) { return createElementImpl(tag); }
    createElementNS(ns, tag) { return createElementImpl(tag); }
    createTextNode(data) { return new Text(data); }
    createComment(data) { return new Comment(data); }
    createDocumentFragment() { return new DocumentFragment(); }
    createEvent(kind) {
      const k = String(kind).toLowerCase();
      const C = k.startsWith('customevent') ? CustomEvent : k.startsWith('mouseevent') ? MouseEvent : k.startsWith('keyboardevent') ? KeyboardEvent : k.startsWith('uievent') ? UIEvent : k === 'event' || k === 'events' || k === 'htmlevents' ? Event : null;
      if (!C) throw new DOMException("The provided event type ('" + kind + "') is invalid.", 'NotSupportedError');
      return new C('');
    }
    getElementById(id) { return descendants(this).find((e) => e.getAttribute('id') === String(id)) || null; }
    getElementsByName(n) { return listLike(descendants(this).filter((e) => e.getAttribute('name') === String(n))); }
  }
  mixin(Document, ParentNodeMixin);
  class HTMLDocument extends Document {}
  const AVAILABLE_FONTS = ['arial', 'arial black', 'calibri', 'cambria', 'consolas', 'courier new', 'georgia', 'helvetica', 'impact', 'segoe ui', 'tahoma', 'times new roman', 'trebuchet ms', 'verdana', 'sans-serif', 'serif', 'monospace'];
  class FontFaceSet extends EventTarget {
    get status() { return 'loaded'; }
    get size() { return 0; }
    get ready() { return Promise.resolve(this); }
    check(font) {
      const fam = String(font).replace(/^.*?\d+(?:\.\d+)?(px|pt|em|rem)\s+/, '').split(',').map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase());
      return fam.every((f) => AVAILABLE_FONTS.includes(f));
    }
    load(font) { return Promise.resolve(this.check(font) ? [{ family: font, status: 'loaded' }] : []); }
  }
  const fontFaceSet = new FontFaceSet();

  // ------------------------------------------------------------------ navigator and friends
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const BRANDS = [{ brand: 'Chromium', version: '128' }, { brand: 'Not;A=Brand', version: '24' }, { brand: 'Google Chrome', version: '128' }];
  const FULL_BRANDS = [{ brand: 'Chromium', version: '128.0.6613.120' }, { brand: 'Not;A=Brand', version: '24.0.0.0' }, { brand: 'Google Chrome', version: '128.0.6613.120' }];
  const cloneBrands = (b) => b.map((x) => ({ brand: x.brand, version: x.version }));

  class MimeType {
    constructor(type, suffixes, description) { hidden(this, S, { type, suffixes, description, plugin: null }); }
    get type() { return priv(this).type; }
    get suffixes() { return priv(this).suffixes; }
    get description() { return priv(this).description; }
    get enabledPlugin() { return priv(this).plugin; }
  }
  class Plugin {
    constructor(name, mimes) {
      hidden(this, S, { name, mimes });
      mimes.forEach((m, i) => Object.defineProperty(this, i, { value: m, enumerable: true, configurable: true }));
      mimes.forEach((m) => Object.defineProperty(this, m.type, { value: m, enumerable: false, configurable: true }));
    }
    get name() { return priv(this).name; }
    get filename() { return 'internal-pdf-viewer'; }
    get description() { return 'Portable Document Format'; }
    get length() { return priv(this).mimes.length; }
    item(i) { return priv(this).mimes[i >>> 0] || null; }
    namedItem(n) { return priv(this).mimes.find((m) => m.type === String(n)) || null; }
    [Symbol.iterator]() { return priv(this).mimes[Symbol.iterator](); }
  }
  class ArrayLikeCollection {
    constructor(items, keyOf) {
      hidden(this, S, { items, keyOf });
      items.forEach((it, i) => Object.defineProperty(this, i, { value: it, enumerable: true, configurable: true }));
      items.forEach((it) => Object.defineProperty(this, keyOf(it), { value: it, enumerable: false, configurable: true }));
    }
    get length() { return priv(this).items.length; }
    item(i) { return priv(this).items[i >>> 0] || null; }
    namedItem(n) { return priv(this).items.find((it) => priv(this).keyOf(it) === String(n)) || null; }
    [Symbol.iterator]() { return priv(this).items[Symbol.iterator](); }
  }
  class PluginArray extends ArrayLikeCollection { refresh() {} }
  class MimeTypeArray extends ArrayLikeCollection {}
  const pdfMime = new MimeType('application/pdf', 'pdf', 'Portable Document Format');
  const textPdfMime = new MimeType('text/pdf', 'pdf', 'Portable Document Format');
  const PLUGIN_NAMES = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
  const pluginObjs = PLUGIN_NAMES.map((n) => new Plugin(n, [pdfMime, textPdfMime]));
  priv(pdfMime).plugin = pluginObjs[0];
  priv(textPdfMime).plugin = pluginObjs[0];
  const pluginArray = new PluginArray(pluginObjs, (p) => p.name);
  const mimeTypeArray = new MimeTypeArray([pdfMime, textPdfMime], (m) => m.type);

  const PERMISSION_STATES = { geolocation: 'prompt', notifications: 'prompt', push: 'prompt', midi: 'granted', camera: 'prompt', microphone: 'prompt',
    'background-fetch': 'granted', 'background-sync': 'granted', 'persistent-storage': 'prompt', 'accelerometer': 'granted', 'gyroscope': 'granted',
    'magnetometer': 'granted', 'clipboard-read': 'prompt', 'clipboard-write': 'granted', 'payment-handler': 'granted', 'idle-detection': 'prompt',
    'screen-wake-lock': 'prompt', 'storage-access': 'granted', 'local-fonts': 'prompt', 'window-management': 'prompt' };
  class PermissionStatus extends EventTarget {
    constructor(name, state) { super(); hidden(this, S, { name, state }); this.onchange = null; }
    get name() { return priv(this).name; }
    get state() { return priv(this).state; }
  }
  class Permissions {
    query(desc) {
      if (!desc || typeof desc !== 'object') return Promise.reject(new TypeError("Failed to execute 'query' on 'Permissions': parameter 1 is not of type 'object'."));
      const name = desc.name;
      if (!Object.prototype.hasOwnProperty.call(PERMISSION_STATES, name)) {
        return Promise.reject(new TypeError("Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': The provided value '" + name + "' is not a valid enum value of type PermissionName."));
      }
      return Promise.resolve(new PermissionStatus(name, PERMISSION_STATES[name]));
    }
  }
  class NavigatorUAData {
    get brands() { return cloneBrands(BRANDS); }
    get mobile() { return false; }
    get platform() { return 'Windows'; }
    getHighEntropyValues(hints) {
      if (!Array.isArray(hints)) return Promise.reject(new TypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': The provided value cannot be converted to a sequence."));
      const all = { architecture: 'x86', bitness: '64', formFactors: ['Desktop'], fullVersionList: cloneBrands(FULL_BRANDS), model: '', platformVersion: '15.0.0', uaFullVersion: '128.0.6613.120', wow64: false };
      const out = { brands: cloneBrands(BRANDS), mobile: false, platform: 'Windows' };
      for (const h of hints) if (Object.prototype.hasOwnProperty.call(all, h)) out[h] = all[h];
      return Promise.resolve(out);
    }
    toJSON() { return { brands: cloneBrands(BRANDS), mobile: false, platform: 'Windows' }; }
  }
  class NetworkInformation extends EventTarget {
    get effectiveType() { return '4g'; }
    get rtt() { return 50; }
    get downlink() { return 10; }
    get saveData() { return false; }
  }
  class BatteryManager extends EventTarget {
    get charging() { return true; }
    get chargingTime() { return 0; }
    get dischargingTime() { return Infinity; }
    get level() { return 1; }
  }
  class MediaDevices extends EventTarget {
    enumerateDevices() {
      return Promise.resolve(['audioinput', 'videoinput', 'audiooutput'].map((kind) => ({ deviceId: '', kind, label: '', groupId: '' })));
    }
  }
  class StorageManager {
    estimate() { return Promise.resolve({ quota: 299977904947, usage: 1843, usageDetails: { indexedDB: 1843 } }); }
    persisted() { return Promise.resolve(false); }
  }
  const beaconLog = [];
  const nav = { permissions: new Permissions(), uaData: new NavigatorUAData(), connection: new NetworkInformation(), mediaDevices: new MediaDevices(), storage: new StorageManager(),
    languages: Object.freeze(['en-US', 'en', 'de']), battery: new BatteryManager() };
  class Navigator {
    get userAgent() { return UA; }
    get appVersion() { return UA.slice('Mozilla/'.length); }
    get appName() { return 'Netscape'; }
    get appCodeName() { return 'Mozilla'; }
    get product() { return 'Gecko'; }
    get productSub() { return '20030107'; }
    get vendor() { return 'Google Inc.'; }
    get vendorSub() { return ''; }
    get platform() { return 'Win32'; }
    get language() { return 'en-US'; }
    get languages() { return nav.languages; }
    get hardwareConcurrency() { return 8; }
    get deviceMemory() { return 8; }
    get maxTouchPoints() { return 0; }
    get webdriver() { return false; }
    get cookieEnabled() { return true; }
    get onLine() { return true; }
    get doNotTrack() { return null; }
    get pdfViewerEnabled() { return true; }
    get plugins() { return pluginArray; }
    get mimeTypes() { return mimeTypeArray; }
    get permissions() { return nav.permissions; }
    get userAgentData() { return nav.uaData; }
    get connection() { return nav.connection; }
    get mediaDevices() { return nav.mediaDevices; }
    get storage() { return nav.storage; }
    javaEnabled() { return false; }
    getBattery() { return Promise.resolve(nav.battery); }
    sendBeacon(url, data) { beaconLog.push([String(url), data === undefined ? '' : String(data)]); return true; }
    vibrate() { return false; }
  }

  class ScreenOrientation extends EventTarget {
    get type() { return 'landscape-primary'; }
    get angle() { return 0; }
    lock() { return Promise.reject(new DOMException('screen.orientation.lock() is not available on this device.', 'NotSupportedError')); }
    unlock() {}
  }
  const orientation = new ScreenOrientation();
  class Screen extends EventTarget {
    get width() { return 1920; }
    get height() { return 1080; }
    get availWidth() { return 1920; }
    get availHeight() { return 1032; }
    get availLeft() { return 0; }
    get availTop() { return 0; }
    get colorDepth() { return 24; }
    get pixelDepth() { return 24; }
    get orientation() { return orientation; }
    get isExtended() { return false; }
  }

  class Performance extends EventTarget {
    constructor() { super(); hidden(this, S, { entries: [] }); }
    get timeOrigin() { return TIME_ORIGIN + 0.5; }
    now() { return perfNow(); }
    mark(name, opts) {
      const e = { name: String(name), entryType: 'mark', startTime: opts && typeof opts.startTime === 'number' ? opts.startTime : perfNow(), duration: 0, detail: (opts && opts.detail) ?? null };
      priv(this).entries.push(e);
      return e;
    }
    measure(name, start, end) {
      const find = (n) => { const m = priv(this).entries.filter((e) => e.name === n && e.entryType === 'mark').pop(); if (!m) throw new DOMException("Failed to execute 'measure' on 'Performance': The mark '" + n + "' does not exist.", 'SyntaxError'); return m.startTime; };
      const s = start === undefined ? 0 : find(start);
      const t = end === undefined ? perfNow() : find(end);
      const e = { name: String(name), entryType: 'measure', startTime: s, duration: t - s, detail: null };
      priv(this).entries.push(e);
      return e;
    }
    getEntries() { return priv(this).entries.slice(); }
    getEntriesByType(t) { return priv(this).entries.filter((e) => e.entryType === t); }
    getEntriesByName(n, t) { return priv(this).entries.filter((e) => e.name === n && (t === undefined || e.entryType === t)); }
    clearMarks(n) { priv(this).entries = priv(this).entries.filter((e) => !(e.entryType === 'mark' && (n === undefined || e.name === n))); }
    clearMeasures(n) { priv(this).entries = priv(this).entries.filter((e) => !(e.entryType === 'measure' && (n === undefined || e.name === n))); }
    get memory() { return { jsHeapSizeLimit: 4294705152, totalJSHeapSize: 18923520, usedJSHeapSize: 13145600 }; }
    get timing() { const t = TIME_ORIGIN; return { navigationStart: t, fetchStart: t + 3, domainLookupStart: t + 5, domainLookupEnd: t + 12, connectStart: t + 12, connectEnd: t + 40, requestStart: t + 41, responseStart: t + 95, responseEnd: t + 110, domLoading: t + 112, domInteractive: t + 180, domContentLoadedEventEnd: t + 190, domComplete: t + 260, loadEventStart: t + 260, loadEventEnd: t + 262 }; }
    toJSON() { return { timeOrigin: this.timeOrigin }; }
  }

  const origCrypto = G.crypto;
  const rng = makePrng(0xc0ffee42);
  class Crypto {
    getRandomValues(arr) {
      const ok = arr instanceof Int8Array || arr instanceof Uint8Array || arr instanceof Uint8ClampedArray || arr instanceof Int16Array || arr instanceof Uint16Array ||
        arr instanceof Int32Array || arr instanceof Uint32Array || (typeof BigInt64Array !== 'undefined' && (arr instanceof BigInt64Array || arr instanceof BigUint64Array));
      if (!ok) throw new DOMException("Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type '" + (arr && arr.constructor ? arr.constructor.name : typeof arr) + "', which is not an integer array type.", 'TypeMismatchError');
      if (arr.byteLength > 65536) throw new DOMException("Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (" + arr.byteLength + ') exceeds the number of bytes of entropy available via this API (65536).', 'QuotaExceededError');
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < bytes.length; i += 4) {
        const r = rng();
        for (let j = 0; j < 4 && i + j < bytes.length; j++) bytes[i + j] = (r >>> (j * 8)) & 255;
      }
      return arr;
    }
    randomUUID() {
      const b = this.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
    get subtle() { return origCrypto ? origCrypto.subtle : undefined; }
  }

  // ------------------------------------------------------------------ matchMedia
  class MediaQueryList extends EventTarget {
    constructor(media, matches) { super(); hidden(this, S, { media, matches }); this.onchange = null; }
    get media() { return priv(this).media; }
    get matches() { return priv(this).matches; }
    addListener(cb) { this.addEventListener('change', cb); }
    removeListener(cb) { this.removeEventListener('change', cb); }
  }
  const WIN = { innerWidth: 1920, innerHeight: 945, outerWidth: 1920, outerHeight: 1032, devicePixelRatio: 1 };
  function evalMediaFeature(f) {
    const m = /^\(\s*([\w-]+)\s*(?::\s*([^)]+?))?\s*\)$/.exec(f.trim());
    if (!m) return null;
    const name = m[1].toLowerCase(), val = m[2] === undefined ? null : m[2].trim().toLowerCase();
    const px = (v) => (/em$/.test(v) ? parseFloat(v) * 16 : parseFloat(v));
    const cmp = (actual, prefix) => (prefix === 'min' ? actual >= px(val) : prefix === 'max' ? actual <= px(val) : actual === px(val));
    let mm;
    if ((mm = /^(min-|max-)?(device-)?(width|height)$/.exec(name))) {
      const actual = mm[2] ? (mm[3] === 'width' ? 1920 : 1080) : mm[3] === 'width' ? WIN.innerWidth : WIN.innerHeight;
      if (val === null) return actual > 0;
      return cmp(actual, mm[1] ? mm[1].slice(0, 3) : '');
    }
    if ((mm = /^(min-|max-)?(-webkit-)?(device-pixel-ratio|resolution)$/.exec(name.replace('-webkit-min-', 'min--webkit-').replace('-webkit-max-', 'max--webkit-')))) {
      const want = parseFloat(val);
      const actual = /dppx|x$/.test(val) || mm[3] === 'device-pixel-ratio' ? WIN.devicePixelRatio : WIN.devicePixelRatio * 96;
      return mm[1] === 'min-' ? actual >= want : mm[1] === 'max-' ? actual <= want : actual === want;
    }
    const fixed = { 'prefers-color-scheme': 'light', 'prefers-reduced-motion': 'no-preference', 'prefers-contrast': 'no-preference', 'prefers-reduced-transparency': 'no-preference',
      'forced-colors': 'none', 'inverted-colors': 'none', pointer: 'fine', 'any-pointer': 'fine', hover: 'hover', 'any-hover': 'hover', 'display-mode': 'browser',
      orientation: WIN.innerWidth >= WIN.innerHeight ? 'landscape' : 'portrait', 'dynamic-range': 'standard', 'video-dynamic-range': 'standard', scripting: 'enabled', update: 'fast', 'overflow-block': 'scroll' };
    if (name === 'color-gamut') return val === 'srgb';
    if (name === 'color') return val === null ? true : parseInt(val, 10) === 8;
    if (name === 'min-color') return 8 >= parseInt(val, 10);
    if (name === 'monochrome') return val === null ? false : parseInt(val, 10) === 0;
    if (name === 'aspect-ratio' || name === 'min-aspect-ratio' || name === 'max-aspect-ratio') {
      const [a, b] = val.split('/').map((x) => parseFloat(x));
      const want = a / (b || 1), actual = WIN.innerWidth / WIN.innerHeight;
      return name.startsWith('min') ? actual >= want : name.startsWith('max') ? actual <= want : Math.abs(actual - want) < 1e-9;
    }
    if (Object.prototype.hasOwnProperty.call(fixed, name)) return val === null ? fixed[name] !== 'none' && fixed[name] !== 'no-preference' : fixed[name] === val;
    return null;
  }
  function evalMediaQuery(q) {
    return q.split(',').some((part) => {
      let s = part.trim().toLowerCase();
      let negate = false;
      if (s.startsWith('not ')) { negate = true; s = s.slice(4); }
      if (s.startsWith('only ')) s = s.slice(5);
      const terms = s.split(/\s+and\s+/);
      let ok = true;
      for (const t of terms) {
        if (t === 'all' || t === 'screen') continue;
        if (t === 'print' || t === 'speech') { ok = false; continue; }
        const r = evalMediaFeature(t);
        if (r === null) return false;
        ok = ok && r;
      }
      return negate ? !ok : ok;
    });
  }
  function matchMedia(query) { query = String(query); return new MediaQueryList(query, evalMediaQuery(query)); }

  // ------------------------------------------------------------------ requestAnimationFrame / idle
  let rafId = 0, rafFrame = 0, rafQueue = [], rafScheduled = false;
  const rafCancelled = new Set();
  function flushFrame() {
    rafScheduled = false;
    rafFrame++;
    const ts = Math.round(rafFrame * 16666.667) / 1000;
    if (perfPeek() < ts) perfTicks = Math.ceil(ts / PERF_STEP);
    const q = rafQueue;
    rafQueue = [];
    for (const [id, cb] of q) {
      if (rafCancelled.has(id)) { rafCancelled.delete(id); continue; }
      try { cb(ts); } catch (err) { console.error('Uncaught', err && err.message ? err.message : err); }
    }
  }
  function requestAnimationFrame(cb) {
    if (typeof cb !== 'function') throw new TypeError("Failed to execute 'requestAnimationFrame' on 'Window': The callback provided as parameter 1 is not a function.");
    const id = ++rafId;
    rafQueue.push([id, cb]);
    if (!rafScheduled) { rafScheduled = true; queueMicrotask(flushFrame); }
    return id;
  }
  function cancelAnimationFrame(id) { if (rafQueue.some((e) => e[0] === id)) rafCancelled.add(id); }
  let idleId = 0;
  function requestIdleCallback(cb) {
    const id = ++idleId;
    queueMicrotask(() => cb({ didTimeout: false, timeRemaining: markNative(function timeRemaining() { return 49.9; }) }));
    return id;
  }
  function cancelIdleCallback() {}

  function getComputedStyle(el) {
    const cs = new CSSStyleDeclaration();
    const inline = ['span', 'a', 'label', 'button', 'input', 'img', 'canvas', 'b', 'i', 'em', 'strong'];
    cs.display = el.hasAttribute && el.hasAttribute('hidden') ? 'none' : inline.includes(el.localName) ? 'inline' : el.localName === 'li' ? 'list-item' : 'block';
    cs.visibility = 'visible';
    cs.color = 'rgb(0, 0, 0)';
    cs.fontFamily = 'Arial';
    cs.fontSize = '16px';
    if (el.style) Object.assign(cs, el.style);
    return cs;
  }

  class Notification extends EventTarget {
    static get permission() { return 'default'; }
    static requestPermission() { return Promise.resolve('default'); }
  }

  // ------------------------------------------------------------------ build the document tree
  const doc = new HTMLDocument();
  priv(doc).title = 'Example Shop – Products';
  function h(tag, attrs, ...kids) {
    const el = createElementImpl(tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const k of kids) el.appendChild(typeof k === 'string' ? new Text(k) : k);
    return el;
  }
  doc.appendChild(
    h('html', { lang: 'en' },
      h('head', null, h('meta', { charset: 'utf-8' }), h('title', null, 'Example Shop – Products'), h('script', { id: 'bootstrap', src: '/static/js/app.js' })),
      h('body', { class: 'page products' },
        h('header', { id: 'site-header', class: 'header' },
          h('nav', { class: 'nav' }, h('a', { class: 'nav-link', href: '/' }, 'Home'), h('a', { class: 'nav-link active', href: '/products' }, 'Products'), h('a', { class: 'nav-link', href: '/cart' }, 'Cart'))),
        h('div', { id: 'app', class: 'container', 'data-page': 'products' }),
        h('div', { id: 'captcha-container', class: 'captcha widget', 'data-sitekey': '6Lc_demo_sitekey_0001' }),
        h('form', { id: 'login-form', action: '/login', method: 'post' },
          h('input', { name: 'username', type: 'text' }), h('input', { name: 'password', type: 'password' }), h('button', { id: 'submit-btn', type: 'submit' }, 'Sign in')),
        h('footer', { class: 'footer' }, '© Example Shop'))));

  // ------------------------------------------------------------------ install
  const location = new Location(START_URL);
  const chromeObj = { app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' } }, runtime: {},
    csi: markNative(function csi() { return { startE: TIME_ORIGIN, onloadT: TIME_ORIGIN + 262, pageT: 1234.5, tran: 15 }; }),
    loadTimes: markNative(function loadTimes() { return { requestTime: TIME_ORIGIN / 1000, startLoadTime: TIME_ORIGIN / 1000, connectionInfo: 'h2', wasFetchedViaSpdy: true, npnNegotiatedProtocol: 'h2' }; }) };

  const classes = { Event, CustomEvent, UIEvent, MouseEvent, PointerEvent, WheelEvent, KeyboardEvent, FocusEvent, PopStateEvent, HashChangeEvent, StorageEvent,
    EventTarget, Node, CharacterData, Text, Comment, DocumentFragment, Element, HTMLElement, HTMLCanvasElement, Document, HTMLDocument, CSSStyleDeclaration, DOMTokenList,
    CanvasRenderingContext2D, CanvasGradient, TextMetrics, ImageData, WebGLRenderingContext, WebGL2RenderingContext, WebGLShaderPrecisionFormat, WebGLObject,
    Location, History, Storage, Navigator, Plugin, PluginArray, MimeType, MimeTypeArray, Permissions, PermissionStatus, NavigatorUAData, NetworkInformation,
    BatteryManager, MediaDevices, StorageManager, Screen, ScreenOrientation, Performance, Crypto, MediaQueryList, FontFaceSet, Notification };
  for (const [name, C] of Object.entries(classes)) nativizeClass(C, name === 'HTMLElement' ? null : name);
  nativizeClass(ArrayLikeCollection, null);
  nativize(ParentNodeMixin, false);

  const winFns = { matchMedia, requestAnimationFrame, cancelAnimationFrame, requestIdleCallback, cancelIdleCallback, getComputedStyle,
    addEventListener: EventTarget.prototype.addEventListener, removeEventListener: EventTarget.prototype.removeEventListener, dispatchEvent: EventTarget.prototype.dispatchEvent,
    scrollTo: function scrollTo() {}, scrollBy: function scrollBy() {}, focus: function focus() {}, blur: function blur() {},
    btoa, atob: origAtob || shimAtob };
  for (const [k, fn] of Object.entries(winFns)) { markNative(fn); define(k, fn); }

  for (const [name, C] of Object.entries(classes)) define(name, C);
  define('window', G);
  define('self', G);
  define('top', G);
  define('parent', G);
  define('frames', G);
  define('opener', null);
  define('name', '');
  define('closed', false);
  define('length', 0);
  define('navigator', new Navigator());
  define('clientInformation', G.navigator);
  define('screen', new Screen());
  define('document', doc);
  define('location', location);
  define('history', new History());
  define('localStorage', new Storage());
  define('sessionStorage', new Storage());
  define('performance', new Performance());
  define('crypto', new Crypto());
  define('chrome', chromeObj);
  define('origin', location.origin);
  define('isSecureContext', true);
  define('devicePixelRatio', WIN.devicePixelRatio);
  define('innerWidth', WIN.innerWidth);
  define('innerHeight', WIN.innerHeight);
  define('outerWidth', WIN.outerWidth);
  define('outerHeight', WIN.outerHeight);
  define('screenX', 0);
  define('screenY', 0);
  define('screenLeft', 0);
  define('screenTop', 0);
  define('scrollX', 0);
  define('scrollY', 0);
  define('pageXOffset', 0);
  define('pageYOffset', 0);
  define('onload', null);
  define('onerror', null);
  define('onmessage', null);
  define('onpopstate', null);
  define('onhashchange', null);
  define('onresize', null);
  define('onfocus', null);
  define('onblur', null);
  define('onmousemove', null);
  define('onclick', null);
  define('onkeydown', null);
  define('onbeforeunload', null);
  define('indexedDB', { open: markNative(function open() { return {}; }) });
  Object.defineProperty(G, Symbol.toStringTag, { value: 'Window', configurable: true });
})(globalThis);
