const state = {
  catalog: null,
  answers: {},
};

const $ = (id) => document.getElementById(id);

async function boot() {
  const [catalogRes, latestRes] = await Promise.all([
    fetch('/api/catalog'),
    fetch('/api/latest'),
  ]);
  if (!catalogRes.ok) throw new Error('无法加载题目目录');
  state.catalog = await catalogRes.json();
  const latest = await latestRes.json();

  $('title').textContent = state.catalog.title;
  $('subtitle').textContent = state.catalog.subtitle;
  $('footnote').textContent = state.catalog.footnote;

  if (!latest.empty && latest.submittedAt) {
    const when = new Date(latest.submittedAt).toLocaleString('zh-CN');
    $('latest-hint').textContent = `上次提交：${when}`;
  } else {
    $('latest-hint').textContent = '尚未提交过';
  }

  renderToc();
  renderSections();
  $('submit-btn').addEventListener('click', onSubmit);
}

function renderToc() {
  const toc = $('toc');
  toc.innerHTML = '';
  for (const section of state.catalog.sections) {
    const a = document.createElement('a');
    a.href = `#${section.id}`;
    a.textContent = section.eyebrow;
    toc.appendChild(a);
  }
}

function renderSections() {
  const root = $('sections');
  root.innerHTML = '';
  for (const section of state.catalog.sections) {
    const el = document.createElement('section');
    el.className = 'section';
    el.id = section.id;

    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = section.eyebrow;
    el.appendChild(eyebrow);

    const h2 = document.createElement('h2');
    h2.textContent = section.title;
    el.appendChild(h2);

    const lead = document.createElement('p');
    lead.className = 'lead';
    lead.textContent = section.lead;
    el.appendChild(lead);

    for (const item of section.items) {
      el.appendChild(renderItem(item));
    }
    root.appendChild(el);
  }
}

function renderItem(item) {
  const box = document.createElement('article');
  box.className = 'item';
  box.dataset.itemId = item.id;

  const h3 = document.createElement('h3');
  h3.textContent = item.question;
  box.appendChild(h3);

  if (item.why) {
    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = item.why;
    box.appendChild(why);
  }

  if (item.kind === 'note') {
    const wrap = document.createElement('div');
    wrap.className = 'note-field';
    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.placeholder = item.placeholder || '';
    ta.addEventListener('input', () => {
      const v = ta.value.trim();
      if (v) state.answers[item.id] = v;
      else delete state.answers[item.id];
    });
    wrap.appendChild(ta);
    box.appendChild(wrap);
    return box;
  }

  const opts = document.createElement('div');
  opts.className = 'options';
  const inputType = item.kind === 'multi' ? 'checkbox' : 'radio';

  for (const option of item.options || []) {
    const label = document.createElement('label');
    label.className = 'option';
    const input = document.createElement('input');
    input.type = inputType;
    input.name = item.id;
    input.value = option.value;
    input.addEventListener('change', () => onOptionChange(item));
    const span = document.createElement('span');
    span.textContent = option.label;
    label.appendChild(input);
    label.appendChild(span);
    opts.appendChild(label);
  }
  box.appendChild(opts);
  return box;
}

function onOptionChange(item) {
  const nodes = document.querySelectorAll(`input[name="${item.id}"]`);
  if (item.kind === 'multi') {
    const values = [...nodes].filter((n) => n.checked).map((n) => n.value);
    if (values.length) state.answers[item.id] = values;
    else delete state.answers[item.id];
    return;
  }
  const picked = [...nodes].find((n) => n.checked);
  if (picked) state.answers[item.id] = picked.value;
  else delete state.answers[item.id];
}

async function onSubmit() {
  const btn = $('submit-btn');
  const status = $('status');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = '正在保存……';

  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submitter: $('submitter').value.trim(),
        globalNote: $('global-note').value.trim(),
        answers: state.answers,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    status.className = 'status ok';
    status.textContent =
      `已保存。开发侧可读：${data.paths.latestMd}` +
      `（编号 ${data.id}）`;
    $('latest-hint').textContent = `刚才已提交：${new Date().toLocaleString('zh-CN')}`;
  } catch (err) {
    status.className = 'status err';
    status.textContent = `提交失败：${err.message || err}`;
  } finally {
    btn.disabled = false;
  }
}

boot().catch((err) => {
  $('status').className = 'status err';
  $('status').textContent = `页面加载失败：${err.message || err}`;
});
