// Question types: what a question looks like in the bank / a quiz, how it is prepared for a game, what players are
// shown, how an answer is checked and how a question's answers are summed up for the reveal. Pure: no I/O.
//
//   choice     options[2-4] + correctIndex                     tap one option
//   truefalse  options ['True', 'False'] + correctIndex       tap one of two
//   type       answers[1-5] (accepted spellings)                type the answer; small typos are forgiven
//   order      items[3-5] in the right order                    put the shuffled items in order
//   number     answer (+ tolerance, unit)                       guess a number; close guesses earn points too
import { GameError } from './errors.js';

export const TYPES = ['choice', 'truefalse', 'type', 'order', 'number'];
export const TYPE_LABELS = {
  choice: 'Multiple choice',
  truefalse: 'True or false',
  type: 'Type it',
  order: 'Put in order',
  number: 'Closest number',
};
/** Types answered by tapping an option (their gate checks the option index). */
export const isTapType = (type) => type === 'choice' || type === 'truefalse';
export const typeOf = (q) => (TYPES.includes(q?.type) ? q.type : 'choice');

/** Points for a close-but-not-right answer (order: share of items in place; number: how close) are at most this. */
export const PARTIAL_MAX = 500;

// ---------- bank / quiz questions ----------
/** The fields a stored question of its type keeps (anything else is dropped). */
export function cleanQuestion(q) {
  const type = typeOf(q);
  const base = { type, text: q.text, category: q.category, timeLimit: q.timeLimit };
  if (isTapType(type)) return { ...base, options: q.options, correctIndex: q.correctIndex };
  if (type === 'type') return { ...base, answers: q.answers };
  if (type === 'order') return { ...base, items: q.items };
  return { ...base, answer: q.answer, tolerance: q.tolerance ?? 0, ...(q.unit ? { unit: q.unit } : {}) };
}

/** The right answer as one line of text (admin lists, reveals). */
export function answerText(q) {
  const type = typeOf(q);
  if (isTapType(type)) return q.options?.[q.correctIndex] ?? '';
  if (type === 'type') return q.answers?.[0] ?? '';
  if (type === 'order') {
    if (q.correctOrder && q.options) return q.correctOrder.map((i) => q.options[i]).join(' → ');
    return (q.items ?? []).join(' → ');
  }
  return `${formatNumber(q.answer)}${q.unit ? ` ${q.unit}` : ''}`;
}

export const formatNumber = (n) => (Number.isFinite(n) ? Number(n.toFixed(4)).toLocaleString('en-US') : String(n));

function shuffled(n, random = Math.random) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A bank / quiz question as stored in a game: `options` is what players see (order: the items shuffled, never in the
 * right order) and the answer key sits next to it (correctIndex / correctOrder / answers / answer).
 */
export function prepareQuestion(q, { double = false, random = Math.random } = {}) {
  const type = typeOf(q);
  const base = { id: q.id, type, text: q.text, category: q.category, timeLimit: q.timeLimit, double: !!double };
  if (isTapType(type)) return { ...base, options: q.options, correctIndex: q.correctIndex };
  if (type === 'type') return { ...base, answers: q.answers };
  if (type === 'order') {
    const n = q.items.length;
    let perm = shuffled(n, random);
    for (let i = 0; i < 5 && perm.every((v, idx) => v === idx); i++) perm = shuffled(n, random); // never pre-solved
    if (perm.every((v, idx) => v === idx)) perm = [...perm.slice(1), perm[0]];
    const options = perm.map((i) => q.items[i]);
    // correctOrder[p] = which shown option belongs at position p
    const correctOrder = q.items.map((_, itemIdx) => perm.indexOf(itemIdx));
    return { ...base, options, correctOrder };
  }
  return { ...base, answer: q.answer, tolerance: q.tolerance ?? 0, unit: q.unit || '' };
}

/** What players see of a game question before its reveal: never the answer key. */
export function publicQuestion(q) {
  const type = typeOf(q);
  const out = { type, text: q.text, timeLimit: q.timeLimit, double: !!q.double };
  if (type !== 'type' && type !== 'number') out.options = q.options;
  else out.options = [];
  if (type === 'number' && q.unit) out.unit = q.unit;
  return out;
}

/** How many options the question's gate accepts (tap types); other types always submit option 0. */
export const gateOptionCount = (q) => (isTapType(typeOf(q)) ? q.options.length : 1);

// ---------- answers ----------
/**
 * Turns an answer:submit payload into what is stored for this question: { choice } for tap types, { answer } for the
 * rest. Throws GameError('Invalid option.') when it doesn't fit the question.
 */
export function normalizeAnswer(q, data) {
  const type = typeOf(q);
  const bad = () => new GameError('Invalid option.');
  if (isTapType(type)) {
    if (!Number.isInteger(data.choice) || data.choice < 0) throw bad();
    return { choice: data.choice };
  }
  if (type === 'type') {
    const text = typeof data.text === 'string' ? data.text.trim().slice(0, 60) : '';
    if (!text) throw bad();
    return { answer: text };
  }
  if (type === 'order') {
    const n = q.options.length;
    const order = data.order;
    if (!Array.isArray(order) || order.length !== n) throw bad();
    if (new Set(order).size !== n || !order.every((i) => Number.isInteger(i) && i >= 0 && i < n)) throw bad();
    return { answer: order };
  }
  const value = data.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad();
  return { answer: value };
}

/** Lowercase, no accents / punctuation / leading article, single spaces. */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Typos forgiven for an accepted answer of this (normalized) length. Numbers must be exact. */
const typoBudget = (s) => (/^[0-9 ]+$/.test(s) ? 0 : s.length <= 3 ? 0 : s.length <= 6 ? 1 : 2);

/** Does a typed answer match one of the accepted ones? */
export function typedMatches(typed, accepted) {
  const t = normalizeText(typed);
  if (!t) return false;
  return (accepted ?? []).some((raw) => {
    const a = normalizeText(raw);
    if (!a) return false;
    if (t === a || t.replace(/ /g, '') === a.replace(/ /g, '')) return true;
    return levenshtein(t, a) <= typoBudget(a);
  });
}

/**
 * Checks one stored answer item ({choice} or {answer}) against a game question.
 * `partial` (0..1) is credit for a close miss: order = share of items in the right place, number = closeness.
 */
export function judge(q, a) {
  if (!a) return { correct: false, partial: 0 };
  const type = typeOf(q);
  if (isTapType(type)) return { correct: a.choice === q.correctIndex, partial: 0 };
  if (type === 'type') return { correct: typedMatches(a.answer, q.answers), partial: 0 };
  if (type === 'order') {
    const order = Array.isArray(a.answer) ? a.answer.map(Number) : [];
    const right = q.correctOrder.filter((v, i) => order[i] === v).length;
    const correct = right === q.correctOrder.length;
    return { correct, partial: correct ? 0 : right / q.correctOrder.length };
  }
  const v = Number(a.answer);
  if (!Number.isFinite(v)) return { correct: false, partial: 0 };
  const err = Math.abs(v - q.answer);
  if (err <= (q.tolerance ?? 0)) return { correct: true, partial: 0 };
  return { correct: false, partial: Math.max(0, 1 - err / Math.max(Math.abs(q.answer), 1)) };
}

/** Type-specific facts for the reveal: popular typed answers, the closest guess and the average... */
export function summarize(q, answers, nameOf) {
  const type = typeOf(q);
  if (type === 'type') {
    const groups = new Map();
    for (const a of answers) {
      const key = normalizeText(a.answer);
      if (!key) continue;
      const g = groups.get(key) ?? { text: String(a.answer).slice(0, 60), count: 0, correct: typedMatches(a.answer, q.answers) };
      g.count += 1;
      groups.set(key, g);
    }
    return { guesses: [...groups.values()].sort((x, y) => y.count - x.count || x.text.localeCompare(y.text)).slice(0, 6) };
  }
  if (type === 'number') {
    const vals = answers.map((a) => ({ v: Number(a.answer), a })).filter((x) => Number.isFinite(x.v));
    if (!vals.length) return {};
    const avg = vals.reduce((s, x) => s + x.v, 0) / vals.length;
    const best = [...vals].sort((x, y) => Math.abs(x.v - q.answer) - Math.abs(y.v - q.answer) || x.a.at - y.a.at)[0];
    const name = nameOf(best.a.seat);
    return { average: Number(avg.toFixed(2)), closest: name ? { username: name, value: best.v } : null };
  }
  if (type === 'order') {
    const perfect = answers.filter((a) => judge(q, a).correct).length;
    return { perfect };
  }
  return {};
}
