'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('input'), output = $('output'), logEl = $('log'), status = $('status');
  const go = $('go'), cancel = $('cancel'), copyBtn = $('copy'), dlBtn = $('download');
  const TIMEOUT_MS = 180000;

  let fileName = 'input.js';
  let result = '';
  let worker = null, timer = null, ticker = null, step = '', started = 0;

  const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(2)} MB`;

  function setStatus(text, cls = '') { status.textContent = text; status.className = cls || 'muted'; }
  function addLog(text, cls = '') {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function placeholder(text) {
    output.textContent = '';
    const s = document.createElement('span');
    s.className = 'muted';
    s.textContent = text;
    output.appendChild(s);
  }
  function updateInput() {
    const n = input.value.length;
    $('inputInfo').textContent = n ? `${fileName} · ${fmtBytes(new Blob([input.value]).size)}` : 'No input yet.';
    go.disabled = !n || !!worker;
    runners.input.sync();
  }
  function setRecovery(st) {
    const box = $('recovery');
    if (!st) { box.hidden = true; return; }
    box.hidden = false;
    $('recoveryBar').style.width = `${st.recoveredPct}%`;
    $('recoveryText').textContent = `${st.recoveredPct} % of ${st.instructions.toLocaleString('en')} VM instructions recovered`;
    $('recoveryDetail').textContent = st.unrecovered
      ? `${st.unrecovered} instruction(s) left as placeholder calls such as __UNKNOWN_12(...); ${st.opcodes - st.opcodesKnown} opcode(s) not identified.`
      : `All ${st.opcodes} opcodes identified, no placeholders.`;
  }
  function setOutput(text) {
    result = text;
    output.textContent = text;
    copyBtn.disabled = dlBtn.disabled = !text;
    runners.output.reset();
  }

  // ---- running either pane in a worker ------------------------------------
  const RUN_TIMEOUT_MS = 15000;
  const compareEl = $('compare');
  function makeRunner(key, getCode) {
    const btn = $(`run${key}`), box = $(`run${key}Box`), out = $(`run${key}Out`), info = $(`run${key}Info`);
    const r = { lines: null, finished: false, w: null, timer: null };
    const line = (text, cls) => {
      const d = document.createElement('div');
      if (cls) d.className = cls;
      d.textContent = text;
      out.appendChild(d);
      out.scrollTop = out.scrollHeight;
    };
    const stop = (msg, cls, finished) => {
      if (r.w) r.w.terminate();
      r.w = null;
      clearTimeout(r.timer);
      r.finished = finished;
      info.textContent = msg;
      info.className = cls || 'muted';
      btn.innerHTML = '&#9654; Run';
      r.sync();
      compare();
    };
    r.sync = () => { btn.disabled = !r.w && !getCode(); };
    r.reset = () => {
      if (r.w) stop('', '', false);
      r.lines = null; r.finished = false;
      box.hidden = true; out.textContent = '';
      r.sync();
      compare();
    };
    btn.addEventListener('click', () => {
      if (r.w) { line('stopped', 's'); stop('stopped', 'muted', false); return; }
      const code = getCode();
      if (!code) return;
      out.textContent = '';
      box.hidden = false;
      r.lines = []; r.finished = false;
      info.textContent = 'running …'; info.className = 'muted';
      btn.textContent = '■ Stop';
      compare();
      const t0 = performance.now();
      r.w = new Worker('runner.js');
      r.timer = setTimeout(() => { line(`stopped after ${RUN_TIMEOUT_MS / 1000} s`, 's'); stop(`stopped after ${RUN_TIMEOUT_MS / 1000} s`, 'warn', false); }, RUN_TIMEOUT_MS);
      r.w.onmessage = (e) => {
        const { type, text } = e.data;
        if (type === 'done' || type === 'exit') {
          const ms = Math.round(performance.now() - t0);
          if (type === 'exit') { r.lines.push(`[exit ${text}]`); line(`process.exit(${text})`, 's'); }
          stop(`finished in ${ms} ms`, 'muted', true);
          return;
        }
        // stack frames differ between the two programs by construction; compare the message only
        if (type === 'log') r.lines.push(...text.split('\n'));
        else r.lines.push(`[${type}] ${type === 'error' ? text.split('\n')[0] : text}`);
        line(text, type === 'warn' ? 'w' : type === 'error' ? 'e' : '');
      };
      r.w.onerror = (e) => { e.preventDefault(); r.lines.push(`[error] ${e.message}`); line(e.message, 'e'); stop('failed', 'err', true); };
      r.w.postMessage({ code });
    });
    return r;
  }
  const runners = {
    input: makeRunner('Input', () => input.value),
    output: makeRunner('Output', () => result),
  };
  function compare() {
    const a = runners.input, b = runners.output;
    if (!a.finished || !b.finished) { compareEl.hidden = true; return; }
    compareEl.hidden = false;
    const n = Math.max(a.lines.length, b.lines.length);
    // measured durations (`1234 ms`, `0.8 s`) differ between an interpreted and a plain program
    const TIME = /\d+(?:[.,]\d+)?\s*(?:ms|µs|us|ns|s|sec|seconds?|Sekunden?)\b/g;
    const norm = (x) => (x === undefined ? x : x.replace(TIME, '<time>'));
    let i = 0, timed = 0;
    for (; i < n; i++) {
      if (a.lines[i] === b.lines[i]) continue;
      if (norm(a.lines[i]) === norm(b.lines[i])) { timed++; continue; }
      break;
    }
    if (i === n) {
      compareEl.textContent = `Both programs printed the same console output (${n} line${n === 1 ? '' : 's'})` +
        (timed ? `, apart from measured times in ${timed} line${timed === 1 ? '' : 's'} (the VM build runs slower).` : '.');
      compareEl.className = 'compare ok';
    } else {
      const show = (x) => (x === undefined ? '(nothing)' : JSON.stringify(x.length > 120 ? `${x.slice(0, 120)}…` : x));
      compareEl.textContent = `The console output differs at line ${i + 1}: obfuscated ${show(a.lines[i])}, decompiled ${show(b.lines[i])}.`;
      compareEl.className = 'compare err';
    }
  }

  input.addEventListener('input', () => { updateInput(); runners.input.reset(); });

  async function loadFile(file) {
    if (!file) return;
    fileName = file.name || 'input.js';
    input.value = await file.text();
    updateInput();
    runners.input.reset();
  }
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  input.addEventListener('dragover', (e) => { e.preventDefault(); input.classList.add('drag'); });
  input.addEventListener('dragleave', () => input.classList.remove('drag'));
  input.addEventListener('drop', (e) => {
    e.preventDefault();
    input.classList.remove('drag');
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });

  $('sample').addEventListener('click', async () => {
    setStatus('Loading example …');
    try {
      const r = await fetch('samples/example.js');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fileName = 'example.js';
      input.value = await r.text();
      updateInput();
      runners.input.reset();
      setStatus('Example loaded: a small program, virtualized with obfuscator.io.');
    } catch (e) { setStatus(`Could not load the example: ${e.message}`, 'err'); }
  });

  function finish() {
    if (worker) worker.terminate();
    worker = null;
    clearTimeout(timer);
    clearInterval(ticker);
    cancel.hidden = true;
    updateInput();
  }

  go.addEventListener('click', () => {
    if (!input.value || worker) return;
    logEl.textContent = '';
    setOutput('');
    setRecovery(null);
    placeholder('Decompiling …');
    $('outputInfo').textContent = '';
    // the current step and the elapsed time, so a long webcrack pass does not look like a hang
    step = 'starting';
    started = performance.now();
    const tick = () => setStatus(`Decompiling … ${Math.floor((performance.now() - started) / 1000)} s · ${step}`);
    tick();
    ticker = setInterval(tick, 500);
    cancel.hidden = false;

    worker = new Worker('decompiler.worker.js');
    go.disabled = true;
    timer = setTimeout(() => {
      addLog(`stopped after ${TIMEOUT_MS / 1000} s`, 'e');
      setStatus('Stopped: the decompiler took too long.', 'err');
      placeholder('No result.');
      finish();
    }, TIMEOUT_MS);

    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'log') {
        addLog(m.text);
        step = m.text.replace(/\s*\.\.\.$/, '').replace(/^normalizing .* with webcrack$/, 'deobfuscating with webcrack (large files take a while)');
      }
      else if (m.type === 'warn') addLog(`warning: ${m.text}`, 'w');
      else if (m.type === 'done') {
        setOutput(m.code);
        const w = m.warnings.length;
        const secs = (m.ms / 1000).toFixed(1);
        if (m.mode === 'webcrack') {
          $('outputInfo').textContent = `no VM found · webcrack only · ${fmtBytes(new Blob([m.code]).size)}`;
          setStatus(`No obfuscator.io VM found; deobfuscated with webcrack instead (${secs} s).`, 'warn');
        } else {
          const st = m.stats;
          const pct = st ? `${st.recoveredPct} %` : '';
          $('outputInfo').textContent = `${m.programs} VM program(s) · ${st ? `${st.opcodesKnown}/${st.opcodes}` : m.opcodes} opcodes identified · ${fmtBytes(new Blob([m.code]).size)}`;
          const full = st && st.unrecovered === 0;
          setRecovery(st);
          setStatus(`Done in ${secs} s. Recovered ${full ? 'all' : `about ${pct} of the`} ${st ? st.instructions.toLocaleString('en') : ''} VM instructions${w ? `, ${w} warning(s), see the log` : ''}.`, full && !w ? 'ok' : 'warn');
        }
        if (w) $('logBox').open = true;
        finish();
      } else if (m.type === 'error') {
        addLog(`error: ${m.text}`, 'e');
        setStatus(`Failed: ${m.text}`, 'err');
        placeholder('No result. Is this a build made with the VM option of obfuscator.io?');
        $('logBox').open = true;
        finish();
      }
    };
    worker.onerror = (e) => {
      addLog(`error: ${e.message}`, 'e');
      setStatus(`Failed: ${e.message}`, 'err');
      placeholder('No result.');
      finish();
    };
    worker.postMessage({ source: input.value, name: fileName, skipWebcrack: $('skipWebcrack').checked });
  });

  cancel.addEventListener('click', () => {
    addLog('cancelled', 'w');
    setStatus('Cancelled.');
    placeholder('No result.');
    finish();
  });

  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(result); setStatus('Copied to the clipboard.', 'ok'); }
    catch { setStatus('Copying failed; select the text and copy it manually.', 'err'); }
  });
  dlBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([result], { type: 'text/javascript' }));
    a.download = fileName.replace(/\.(m|c)?js$/i, '') + '.dec.js';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  updateInput();
})();
