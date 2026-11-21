// Question bank: search and filter, add / edit / delete, bulk delete, import (Open Trivia DB or a JSON file),
// export to JSON, and rename or merge categories.
import { api, el, toast, withPending, confirmDialog } from '../common.js';
import { questionEditor, answerSummary, TYPE_LABELS, TYPE_ICONS } from '../qeditor.js';
import { aicon } from './icons.js';
import {
  pageHead, dataTable, pager, searchBox, select, button, act, loading, failed, empty, when, num, plural, pill, formDialog,
  download, fill,
} from './ui.js';

const PAGE = 50;
const IMPORT_CHUNK = 100; // the API takes request bodies up to 50 KB
const view = { q: '', category: '', type: '', page: 0 };
const selected = new Set();

export async function render(body, args, ctx) {
  let questions;
  loading(body);
  try {
    ({ questions } = await api('/api/admin/questions'));
  } catch (err) {
    return failed(body, err, () => render(body, args, ctx));
  }
  if (!ctx.isCurrent()) return undefined;
  const reload = () => render(body, args, ctx);
  const known = new Set(questions.map((q) => q.id));
  for (const id of selected) if (!known.has(id)) selected.delete(id);

  const counts = new Map();
  for (const q of questions) counts.set(q.category, (counts.get(q.category) || 0) + 1);
  const categories = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const typeCounts = new Map();
  for (const q of questions) typeCounts.set(q.type || 'choice', (typeCounts.get(q.type || 'choice') || 0) + 1);

  const results = el('div');
  const matches = (q) => {
    const s = view.q.toLowerCase();
    return (!view.category || q.category === view.category) && (!view.type || (q.type || 'choice') === view.type)
      && (!s || q.text.toLowerCase().includes(s) || answerSummary(q).toLowerCase().includes(s));
  };

  function drawResults() {
    const rows = questions.filter(matches);
    view.page = Math.min(view.page, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
    const pageRows = rows.slice(view.page * PAGE, (view.page + 1) * PAGE);
    const bulk = selected.size ? el('div', { class: 'bulkbar' },
      el('span', { class: 'grow' }, el('b', {}, num(selected.size)), ` selected`),
      button('Clear', 'x', () => { selected.clear(); drawResults(); }, 'ghost small'),
      button('Delete selected', 'trash', act('Deleting…', async (busy) => {
        const ok = await confirmDialog({ title: `Delete ${plural(selected.size, 'question')}?`, message: "This can't be undone.", confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        const res = await busy(() => api('/api/admin/questions/bulk-delete', { method: 'POST', body: { ids: [...selected] } }));
        if (!res) return;
        selected.clear();
        toast(`Deleted ${plural(res.deleted, 'question')}`);
        await reload();
      }), 'danger small')) : null;

    fill(results, bulk, el('div', { class: 'card flush' },
      dataTable([
        {
          label: 'Question', cls: 'wrap-text', cell: (q) => el('div', {},
            el('div', { class: 'q-text' }, q.text),
            el('div', { class: 'q-meta' }, pill(q.category), el('span', { class: 'cell-sub', style: 'margin:0' }, `${q.timeLimit ?? 20} s`))),
        },
        { label: 'Type', cls: 'type-cell', cell: (q) => el('span', { title: TYPE_LABELS[q.type || 'choice'] }, aicon(TYPE_ICONS[q.type || 'choice'] ?? 'choice', { size: 16 }), el('span', { class: 'sr-only' }, TYPE_LABELS[q.type || 'choice'])) },
        { label: 'Answer', cell: (q) => answerSummary(q) },
        { label: 'Added', cell: (q) => when(q.createdAt) },
        {
          label: '', cls: 'actions', cell: (q) => [
            el('button', { type: 'button', class: 'ghost small icon-btn', title: 'Edit', 'aria-label': 'Edit question', onclick: () => editView(body, q, reload) }, aicon('edit', { size: 15 })),
            el('button', {
              type: 'button', class: 'ghost danger small icon-btn', title: 'Delete', 'aria-label': 'Delete question',
              onclick: act('…', async (busy) => {
                const ok = await confirmDialog({ title: 'Delete this question?', message: q.text, confirmLabel: 'Delete', danger: true });
                if (!ok) return;
                await busy(() => api(`/api/admin/questions/${q.id}`, { method: 'DELETE' }));
                selected.delete(q.id);
                toast('Deleted');
                await reload();
              }),
            }, aicon('trash', { size: 15 }))],
        },
      ], pageRows, {
        select: {
          has: (q) => selected.has(q.id),
          toggle: (q, on) => { if (on) selected.add(q.id); else selected.delete(q.id); drawResults(); },
          all: (on) => { for (const q of pageRows) { if (on) selected.add(q.id); else selected.delete(q.id); } drawResults(); },
          allChecked: pageRows.length > 0 && pageRows.every((q) => selected.has(q.id)),
        },
        emptyNode: empty('help', questions.length ? 'No questions match' : 'No questions yet', questions.length ? 'Try another search or filter.' : 'Add one, or import some from the web.'),
      }),
      pager(rows.length, view.page, PAGE, (p) => { view.page = p; drawResults(); window.scrollTo({ top: 0 }); })));
  }

  const fileInput = el('input', { type: 'file', accept: '.json,application/json', class: 'file-input' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await importFile(file, reload);
  });

  fill(body,
    pageHead('Question bank', `${plural(questions.length, 'question')} in ${plural(categories.length, 'category', 'categories')}`,
      button('New question', 'plus', () => editView(body, null, reload)),
      button('Import from the web', 'globe', () => triviaView(body, reload), 'ghost'),
      button('Import file', 'upload', () => fileInput.click(), 'ghost'),
      button('Export', 'download', () => exportJson(questions.filter(matches)), 'ghost'),
      button('Rename category', 'tag', act('Saving…', (busy) => renameCategory(categories, reload, busy)), 'ghost'),
      fileInput),
    el('div', { class: 'tools' },
      searchBox(view.q, 'Search questions or answers…', (v) => { view.q = v; view.page = 0; drawResults(); }),
      select([['', `All categories (${num(questions.length)})`], ...categories.map((c) => [c, `${c} (${num(counts.get(c))})`])],
        view.category, (v) => { view.category = v; view.page = 0; drawResults(); }, 'Category'),
      select([['', 'All types'], ...Object.keys(TYPE_LABELS).map((t) => [t, `${TYPE_LABELS[t]} (${num(typeCounts.get(t) || 0)})`])],
        view.type, (v) => { view.type = v; view.page = 0; drawResults(); }, 'Type')),
    results);
  drawResults();
  return undefined;
}

function editView(body, existing, done) {
  const editor = questionEditor(existing);
  const error = el('div', { class: 'error', role: 'alert' });
  const save = el('button', {
    type: 'button',
    onclick: () => withPending(save, 'Saving…', async () => {
      error.textContent = '';
      let payload;
      try {
        payload = editor.read();
      } catch (e) {
        error.textContent = e.message;
        return;
      }
      try {
        await api(existing ? `/api/admin/questions/${existing.id}` : '/api/admin/questions', { method: existing ? 'PUT' : 'POST', body: payload });
        toast(existing ? 'Saved' : 'Question added');
        await done();
      } catch (e) {
        error.textContent = e.message;
      }
    }),
  }, existing ? 'Save changes' : 'Add question');
  const cancel = el('button', { type: 'button', class: 'ghost', onclick: () => done() }, 'Cancel');
  fill(body,
    el('a', { class: 'back', href: '#/questions', onclick: (e) => { e.preventDefault(); done(); } }, aicon('arrowLeft', { size: 15 }), 'Question bank'),
    el('div', { class: 'card', style: 'max-width:760px' },
      el('h3', {}, existing ? 'Edit question' : 'New question'),
      editor.node,
      error,
      el('div', { class: 'row', style: 'margin-top:16px' }, save, cancel)));
  editor.focus();
}

async function triviaView(body, done) {
  let categories = {};
  try {
    ({ categories = {} } = await api('/api/admin/trivia/categories'));
  } catch { /* "any category" only */ }
  const cat = el('select', { id: 'tv-cat' }, el('option', { value: '' }, 'Any category'),
    ...Object.entries(categories).map(([name, id]) => el('option', { value: id }, name)));
  const count = el('input', { id: 'tv-count', type: 'number', min: 1, max: 50, value: 10 });
  const diff = el('select', { id: 'tv-diff' }, [['', 'Any difficulty'], ['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']].map(([v, t]) => el('option', { value: v }, t)));
  const error = el('div', { class: 'error', role: 'alert' });
  const go = el('button', {
    type: 'button',
    onclick: () => withPending(go, 'Importing…', async () => {
      error.textContent = '';
      try {
        const res = await api('/api/admin/trivia/import', { method: 'POST', body: { amount: Number(count.value) || 10, category: cat.value, difficulty: diff.value } });
        toast(`Imported ${plural(res.imported, 'new question')} (${num(res.totalFetched - res.imported)} already existed)`);
        await done();
      } catch (e) {
        error.textContent = e.message;
      }
    }),
  }, 'Import');
  fill(body,
    el('a', { class: 'back', href: '#/questions', onclick: (e) => { e.preventDefault(); done(); } }, aicon('arrowLeft', { size: 15 }), 'Question bank'),
    el('div', { class: 'card', style: 'max-width:520px' },
      el('h3', { class: 'with-icon' }, aicon('globe', { size: 22 }), 'Import from the web'),
      el('p', { class: 'muted' }, 'Fetch multiple-choice trivia from the Open Trivia Database. Questions already in the bank are skipped.'),
      el('label', { for: 'tv-cat' }, 'Category'), cat,
      el('label', { for: 'tv-count' }, 'How many (1-50)'), count,
      el('label', { for: 'tv-diff' }, 'Difficulty'), diff,
      error,
      el('div', { class: 'row', style: 'margin-top:16px' }, go, el('button', { type: 'button', class: 'ghost', onclick: () => done() }, 'Cancel'))));
}

/** The bank's own format: what the API accepts, without ids or dates. */
const portable = ({ id, createdAt, ...q }) => q;

function exportJson(questions) {
  if (!questions.length) return toast('Nothing to export');
  download(`quibble-questions-${new Date().toISOString().slice(0, 10)}.json`, `${JSON.stringify({ questions: questions.map(portable) }, null, 2)}\n`);
  toast(`Exported ${plural(questions.length, 'question')}`);
}

async function importFile(file, done) {
  let list;
  try {
    const parsed = JSON.parse(await file.text());
    list = Array.isArray(parsed) ? parsed : parsed?.questions;
    if (!Array.isArray(list) || !list.length) throw new Error('no questions');
  } catch {
    toast('That file is not a question export (a JSON list of questions).');
    return;
  }
  const ok = await confirmDialog({
    title: `Import ${plural(list.length, 'question')}?`,
    message: `From ${file.name}. Questions whose text is already in the bank are skipped.`,
    confirmLabel: 'Import',
  });
  if (!ok) return;
  let imported = 0;
  let skipped = 0;
  try {
    for (let i = 0; i < list.length; i += IMPORT_CHUNK) {
      const res = await api('/api/admin/questions/import', { method: 'POST', body: { questions: list.slice(i, i + IMPORT_CHUNK) } });
      imported += res.imported;
      skipped += res.skipped;
    }
  } catch (err) {
    // Chunks are imported one by one: say how far it got.
    const at = err.message.replace(/^Question (\d+)/, (_, n) => `Question ${Number(n) + imported + skipped}`);
    toast(imported ? `Imported ${num(imported)}, then stopped: ${at}` : at);
    await done();
    return;
  }
  toast(`Imported ${plural(imported, 'question')}${skipped ? ` (${num(skipped)} already existed)` : ''}`);
  await done();
}

async function renameCategory(categories, done, busy) {
  if (!categories.length) return toast('There are no categories yet');
  const v = await formDialog({
    title: 'Rename a category',
    message: 'Every question in it moves to the new name. Pick an existing name to merge two categories.',
    confirmLabel: 'Rename',
    fields: [
      { name: 'from', label: 'Category', type: 'select', options: categories.map((c) => [c, c]), value: view.category || categories[0] },
      { name: 'to', label: 'New name', maxlength: 40, placeholder: 'e.g. Science' },
    ],
    validate: ({ from, to }) => (!to ? 'Type the new name.' : to === from ? 'Pick a different name.' : null),
  });
  if (!v) return;
  const res = await busy(() => api('/api/admin/categories/rename', { method: 'POST', body: v }));
  if (!res) return;
  if (view.category === v.from) view.category = v.to;
  toast(`Moved ${plural(res.moved, 'question')} to ${v.to}`);
  await done();
}

