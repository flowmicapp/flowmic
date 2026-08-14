const $ = (sel) => document.querySelector(sel);

const state = {
  scripts: null,
  index: 0,
  recorder: null,
  chunks: [],
  startedAt: 0,
  timerId: null,
  mime: '',
};

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function pickMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function load() {
  const [scriptsRes, statusRes] = await Promise.all([
    fetch('/scripts.json'),
    fetch('/api/status'),
  ]);
  state.scripts = await scriptsRes.json();
  const status = await statusRes.json();
  $('#corpus-dir').textContent = status.corpusDir || '(unknown)';
  renderNav();
  renderSeg();
  renderTakes(status.takes || []);
}

function renderNav() {
  const nav = $('#seg-nav');
  nav.innerHTML = '';
  for (let i = 0; i < state.scripts.segments.length; i++) {
    const seg = state.scripts.segments[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = seg.id;
    btn.title = seg.label;
    if (i === state.index) btn.classList.add('active');
    btn.addEventListener('click', () => {
      state.index = i;
      renderNav();
      renderSeg();
    });
    nav.appendChild(btn);
  }
}

function renderSeg() {
  const seg = state.scripts.segments[state.index];
  $('#seg-title').textContent = `${seg.id} · ${seg.label}`;
  $('#seg-hint').textContent = `约 ${seg.approx_sec} 秒 · 普通话正常语速 · 可重录覆盖采用时再挑 take`;
  $('#script').textContent = seg.text;
  $('#status').textContent = '';
  $('#status').className = 'status';
}

function renderTakes(takes) {
  const ul = $('#takes-list');
  ul.innerHTML = '';
  if (!takes.length) {
    ul.innerHTML = '<li>还没有录音。点「开始录音」即可。</li>';
    markDone(new Set());
    return;
  }
  const done = new Set();
  for (const t of [...takes].reverse()) {
    done.add(t.seg_id);
    const li = document.createElement('li');
    li.innerHTML = `<strong>${t.seg_id}</strong> · ${t.relative_path} · ${(t.bytes / 1024).toFixed(1)} KB · ${t.recorded_at}`;
    ul.appendChild(li);
  }
  markDone(done);
}

function markDone(doneSet) {
  for (const btn of $('#seg-nav').querySelectorAll('button')) {
    btn.classList.toggle('done', doneSet.has(btn.textContent.trim()));
  }
}

async function startRec() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.mime = pickMime();
  state.chunks = [];
  state.recorder = new MediaRecorder(stream, state.mime ? { mimeType: state.mime } : undefined);
  state.recorder.ondataavailable = (e) => {
    if (e.data?.size) state.chunks.push(e.data);
  };
  state.recorder.onstop = () => {
    for (const t of stream.getTracks()) t.stop();
    void uploadTake();
  };
  state.recorder.start(250);
  state.startedAt = Date.now();
  $('#btn-start').disabled = true;
  $('#btn-stop').disabled = false;
  $('#timer').innerHTML = '<span class="rec-dot"></span>00:00';
  state.timerId = setInterval(() => {
    $('#timer').innerHTML = `<span class="rec-dot"></span>${fmtMs(Date.now() - state.startedAt)}`;
  }, 200);
  $('#status').textContent = '录音中…念完后点停止并自动保存。';
  $('#status').className = 'status';
}

function stopRec() {
  if (!state.recorder || state.recorder.state === 'inactive') return;
  clearInterval(state.timerId);
  state.timerId = null;
  state.recorder.stop();
  $('#btn-stop').disabled = true;
}

async function uploadTake() {
  const seg = state.scripts.segments[state.index];
  const type = state.mime || 'audio/webm';
  const ext = type.includes('mp4') ? '.mp4' : type.includes('ogg') ? '.ogg' : '.webm';
  const blob = new Blob(state.chunks, { type });
  const fd = new FormData();
  fd.append('audio', blob, `${seg.id}${ext}`);
  fd.append('seg_id', seg.id);
  fd.append('label', seg.label);
  fd.append('script', seg.text);
  $('#status').textContent = '保存中…';
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'upload failed');
    $('#status').textContent = `已保存：${body.relative_path}`;
    $('#status').className = 'status ok';
    const st = await (await fetch('/api/status')).json();
    renderTakes(st.takes || []);
  } catch (err) {
    $('#status').textContent = `保存失败：${err.message || err}`;
    $('#status').className = 'status err';
  } finally {
    $('#btn-start').disabled = false;
    $('#btn-stop').disabled = true;
    $('#timer').textContent = '00:00';
  }
}

$('#btn-start').addEventListener('click', () => {
  startRec().catch((err) => {
    $('#status').textContent = `无法开麦：${err.message || err}`;
    $('#status').className = 'status err';
  });
});
$('#btn-stop').addEventListener('click', stopRec);

load().catch((err) => {
  $('#status').textContent = `加载失败：${err.message || err}`;
  $('#status').className = 'status err';
});
