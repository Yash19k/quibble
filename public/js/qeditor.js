// Question editor for every question type, shared by the admin panel and the "My quizzes" builder.
//   const ed = questionEditor(existing, { withCategory, compact })
//   ed.node    the form (append it anywhere)
//   ed.read()  the question as the API wants it; throws Error(message) when something is missing
import { el } from './common.js';
import { icon } from './icons.js';

export const TYPE_LABELS = {
  choice: 'Multiple choice',
  truefalse: 'True / false',
  type: 'Type it',
  order: 'Put in order',
  number: 'Closest number',
};
/** Icon names (icons.js) for each type. */
export const TYPE_ICONS = { choice: 'choice', truefalse: 'truefalse', type: 'type', order: 'order', number: 'number' };
export const TYPE_HINTS = {
  choice: 'Players tap one of 2-4 answers.',
  truefalse: 'Players tap True or False. Quick and punchy.',
  type: 'Players type the answer. Small typos, capitals and accents are forgiven.',
  order: 'Players put the items in the right order. Partly right still scores.',
  number: 'Players guess a number. Exact (or within the tolerance) wins; close guesses still score.',
};

const typeOf = (q) => (q?.type && TYPE_LABELS[q.type] ? q.type : 'choice');

/** One line describing the right answer (lists, tables). */
export function answerSummary(q) {
  const t = typeOf(q);
  // Bank true/false questions loaded by the seed have no stored options: their answer is still True or False.
  if (t === 'truefalse') return (q.options ?? ['True', 'False'])[q.correctIndex] ?? '';
  if (t === 'choice') return q.options?.[q.correctIndex] ?? '';
  if (t === 'type') return (q.answers ?? []).join(' / ');
  if (t === 'order') return (q.items ?? []).join(' → ');
  return `${q.answer}${q.unit ? ` ${q.unit}` : ''}${q.tolerance ? ` (±${q.tolerance})` : ''}`;
}

let editorSeq = 0;

export function questionEditor(existing = null, { withCategory = true } = {}) {
  const id = `qe${++editorSeq}`;
  let type = typeOf(existing);
  const text = el('textarea', { rows: 2, maxlength: 300, value: existing?.text || '', 'aria-label': 'Question', placeholder: 'Ask something fun…' });
  const category = el('input', { maxlength: 40, value: existing?.category || 'General', 'aria-label': 'Category' });
  const time = el('input', { type: 'number', min: 5, max: 60, value: existing?.timeLimit || 20, 'aria-label': 'Time limit (seconds)' });
  const hint = el('p', { class: 'hint' });

  // --- choice ---
  const isChoice = type === 'choice';
  const opts = [0, 1, 2, 3].map((i) => el('input', {
    maxlength: 100, placeholder: i < 2 ? `Answer ${i + 1} (required)` : `Answer ${i + 1} (optional)`,
    value: isChoice ? existing?.options?.[i] || '' : '', 'aria-label': `Answer ${i + 1}`,
  }));
  const radios = [0, 1, 2, 3].map((i) => el('input', {
    type: 'radio', name: `${id}-correct`, value: i, checked: (isChoice ? existing?.correctIndex ?? 0 : 0) === i, 'aria-label': `Answer ${i + 1} is correct`,
  }));
  const choicePanel = el('div', {},
    el('label', {}, 'Answers (select the right one)'),
    opts.map((o, i) => el('div', { class: 'opt-row' }, radios[i], o)));

  // --- true / false ---
  const tfTrue = el('input', { type: 'radio', name: `${id}-tf`, checked: type !== 'truefalse' || existing?.correctIndex !== 1 });
  const tfFalse = el('input', { type: 'radio', name: `${id}-tf`, checked: type === 'truefalse' && existing?.correctIndex === 1 });
  const tfPanel = el('div', {},
    el('label', {}, 'The statement is…'),
    el('div', { class: 'row' },
      el('label', { class: 'check-row' }, tfTrue, el('span', {}, 'True')),
      el('label', { class: 'check-row' }, tfFalse, el('span', {}, 'False'))));

  // --- type it ---
  const accepted = [0, 1, 2, 3, 4].map((i) => el('input', {
    maxlength: 60, placeholder: i === 0 ? 'Right answer (required)' : 'Also accept… (optional)',
    value: existing?.answers?.[i] || '', 'aria-label': `Accepted answer ${i + 1}`,
  }));
  const typePanel = el('div', {}, el('label', {}, 'Accepted answers'), accepted.map((a) => el('div', { class: 'opt-row' }, a)));

  // --- order ---
  const items = [0, 1, 2, 3, 4].map((i) => el('input', {
    maxlength: 60, placeholder: i < 3 ? `Item ${i + 1} (required)` : `Item ${i + 1} (optional)`,
    value: existing?.items?.[i] || '', 'aria-label': `Item ${i + 1}`,
  }));
  const orderPanel = el('div', {},
    el('label', {}, 'Items in the RIGHT order (players see them shuffled)'),
    items.map((it, i) => el('div', { class: 'opt-row' }, el('span', { class: 'order-num' }, i + 1), it)));

  // --- number ---
  const answer = el('input', { type: 'number', step: 'any', value: existing?.answer ?? '', 'aria-label': 'Right number' });
  const tolerance = el('input', { type: 'number', step: 'any', min: 0, value: existing?.tolerance ?? 0, 'aria-label': 'Tolerance' });
  const unit = el('input', { maxlength: 20, value: existing?.unit || '', placeholder: 'e.g. km', 'aria-label': 'Unit' });
  const numberPanel = el('div', { class: 'grid3' },
    el('div', {}, el('label', {}, 'Right number'), answer),
    el('div', {}, el('label', {}, 'Counts as right within ±'), tolerance),
    el('div', {}, el('label', {}, 'Unit (optional)'), unit));

  const panels = { choice: choicePanel, truefalse: tfPanel, type: typePanel, order: orderPanel, number: numberPanel };
  const typeButtons = Object.entries(TYPE_LABELS).map(([t, label]) => el('button', {
    type: 'button', class: 'cat-box type-box', 'data-type': t, onclick: () => setType(t),
  }, icon(TYPE_ICONS[t], { size: 16 }), label));

  function setType(t) {
    type = t;
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== t;
    for (const b of typeButtons) {
      const on = b.dataset.type === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    hint.textContent = TYPE_HINTS[t];
  }

  const node = el('div', { class: 'qeditor' },
    el('label', {}, 'Question type'),
    el('div', { class: 'cat-grid', role: 'group', 'aria-label': 'Question type' }, typeButtons),
    hint,
    el('label', {}, 'Question'), text,
    Object.values(panels),
    el('div', { class: withCategory ? 'grid2' : '' },
      withCategory ? el('div', {}, el('label', {}, 'Category'), category) : null,
      el('div', {}, el('label', {}, 'Time limit (seconds)'), time)));
  setType(type);

  function read() {
    const fail = (msg) => { throw new Error(msg); };
    const q = { type, text: text.value.trim(), timeLimit: Number(time.value) || 20 };
    if (withCategory) q.category = category.value.trim() || 'General';
    if (q.text.length < 3) fail('Write a question (at least 3 characters).');
    if (type === 'choice') {
      const filled = opts.map((o, i) => ({ v: o.value.trim(), i })).filter((o) => o.v);
      const correct = radios.findIndex((r) => r.checked);
      const correctIndex = filled.findIndex((o) => o.i === correct);
      if (filled.length < 2) fail('Give at least 2 answers.');
      if (correctIndex < 0) fail('The answer marked right must not be empty.');
      Object.assign(q, { options: filled.map((o) => o.v), correctIndex });
    } else if (type === 'truefalse') {
      Object.assign(q, { options: ['True', 'False'], correctIndex: tfFalse.checked ? 1 : 0 });
    } else if (type === 'type') {
      const answers = accepted.map((a) => a.value.trim()).filter(Boolean);
      if (!answers.length) fail('Give the right answer.');
      q.answers = answers;
    } else if (type === 'order') {
      const list = items.map((a) => a.value.trim()).filter(Boolean);
      if (list.length < 3) fail('Give at least 3 items.');
      if (new Set(list.map((s) => s.toLowerCase())).size !== list.length) fail('The items must all be different.');
      q.items = list;
    } else {
      if (answer.value === '' || !Number.isFinite(Number(answer.value))) fail('Give the right number.');
      Object.assign(q, { answer: Number(answer.value), tolerance: Math.max(0, Number(tolerance.value) || 0) });
      if (unit.value.trim()) q.unit = unit.value.trim();
    }
    return q;
  }

  return { node, read, focus: () => text.focus() };
}
