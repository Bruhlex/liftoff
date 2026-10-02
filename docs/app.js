'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('input'), output = $('output'), logEl = $('log'), status = $('status');
  const go = $('go'), cancel = $('cancel'), copyBtn = $('copy'), dlBtn = $('download');
  const TIMEOUT_MS = 180000;

  let fileName = 'input.js';
  let result = '';
  let worker = null, timer = null;

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
  }

  input.addEventListener('input', updateInput);

  async function loadFile(file) {
    if (!file) return;
    fileName = file.name || 'input.js';
    input.value = await file.text();
    updateInput();
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
      setStatus('Example loaded: a small program, virtualized with obfuscator.io.');
    } catch (e) { setStatus(`Could not load the example: ${e.message}`, 'err'); }
  });

  function finish() {
    if (worker) worker.terminate();
    worker = null;
    clearTimeout(timer);
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
    setStatus('Decompiling …');
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
      if (m.type === 'log') addLog(m.text);
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
