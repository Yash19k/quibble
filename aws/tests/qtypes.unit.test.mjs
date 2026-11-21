// Unit tests for question types, streaks, double points and the reveal's facts (lib/qtypes.js, lib/views.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../backend/src/lib/qtypes.js';
import { scoreQuestion, myChoiceFor, questionShow, awardsOf } from '../backend/src/lib/views.js';
import { streakBonus } from '../backend/src/lib/scoring.js';

process.env.JWT_SECRET ??= 'unit-test-secret-0123456789abcdef0123456789abcdef';
const { doubleRounds } = await import('../backend/src/lib/game.js');

test('typed answers forgive case, accents, articles and small typos, but not wrong numbers', () => {
  assert.ok(Q.typedMatches('paris', ['Paris']));
  assert.ok(Q.typedMatches('  PARIS!! ', ['Paris']));
  assert.ok(Q.typedMatches('Parris', ['Paris']));
  assert.ok(Q.typedMatches('the beatles', ['Beatles']));
  assert.ok(Q.typedMatches('Sao Paulo', ['São Paulo']));
  assert.ok(Q.typedMatches('leonardo da vinci', ['Leonardo da Vinci']));
  assert.ok(Q.typedMatches('Mercurry', ['Mercury']));
  assert.ok(Q.typedMatches('eleven', ['11', 'eleven']));
  assert.ok(!Q.typedMatches('12', ['11']));
  assert.ok(!Q.typedMatches('Ag', ['Au']), 'short answers must be exact');
  assert.ok(!Q.typedMatches('London', ['Paris']));
  assert.ok(!Q.typedMatches('', ['Paris']));
});

test('order questions are never shown pre-solved, and the key maps back to the items', () => {
  const q = { type: 'order', text: 'Order', items: ['a', 'b', 'c', 'd'], timeLimit: 20 };
  for (let i = 0; i < 200; i++) {
    const g = Q.prepareQuestion(q);
    assert.notDeepEqual(g.options, q.items);
    assert.deepEqual(g.correctOrder.map((k) => g.options[k]), q.items);
  }
  // Even a random source that always returns the identity can't produce a solved puzzle.
  const g = Q.prepareQuestion(q, { random: () => 0.999 });
  assert.notDeepEqual(g.options, q.items);
  assert.deepEqual(g.correctOrder.map((k) => g.options[k]), q.items);
});

test('the answer key never reaches players before the reveal', () => {
  const header = { code: 'ABCDEF', version: 3, total: 5, playerCount: 2 };
  const timing = { k: 0, endsAt: 1, acceptUntil: 2 };
  const forms = [
    { type: 'choice', text: 't', options: ['a', 'b'], correctIndex: 1, timeLimit: 10 },
    { type: 'type', text: 't', answers: ['secret'], timeLimit: 10 },
    { type: 'order', text: 't', items: ['x', 'y', 'z'], timeLimit: 10 },
    { type: 'number', text: 't', answer: 42, tolerance: 1, unit: 'kg', timeLimit: 10 },
  ];
  for (const f of forms) {
    const shown = JSON.stringify(questionShow(header, Q.prepareQuestion(f), timing, 0));
    for (const key of ['correctIndex', 'correctOrder', 'answers', 'secret', '"answer"', 'tolerance']) {
      assert.ok(!shown.includes(key), `${f.type} question leaks ${key}`);
    }
  }
});

test('answers must fit the question type', () => {
  const order = Q.prepareQuestion({ type: 'order', items: ['a', 'b', 'c'] });
  assert.deepEqual(Q.normalizeAnswer(order, { order: [2, 0, 1] }), { answer: [2, 0, 1] });
  assert.throws(() => Q.normalizeAnswer(order, { order: [0, 0, 1] }));
  assert.throws(() => Q.normalizeAnswer(order, { order: [0, 1] }));
  assert.throws(() => Q.normalizeAnswer(order, { choice: 0 }));
  assert.throws(() => Q.normalizeAnswer({ type: 'type', answers: ['x'] }, { text: '   ' }));
  assert.throws(() => Q.normalizeAnswer({ type: 'number', answer: 1 }, { value: Infinity }));
  assert.deepEqual(Q.normalizeAnswer({ type: 'choice', options: ['a', 'b'] }, { choice: 1, text: 'ignored' }), { choice: 1 });
});

test('order and number questions give partial credit', () => {
  const order = { type: 'order', options: ['c', 'a', 'b'], correctOrder: [1, 2, 0] }; // a, b, c
  assert.deepEqual(Q.judge(order, { answer: [1, 2, 0] }), { correct: true, partial: 0 });
  assert.equal(Q.judge(order, { answer: [1, 0, 2] }).partial, 1 / 3);
  const num = { type: 'number', answer: 200, tolerance: 5 };
  assert.equal(Q.judge(num, { answer: 204 }).correct, true);
  const close = Q.judge(num, { answer: 150 });
  assert.equal(close.correct, false);
  assert.equal(close.partial, 0.75);
  assert.equal(Q.judge(num, { answer: 9999 }).partial, 0);
});

test('streak bonus: 3rd right answer in a row pays 100, growing to a 500 cap', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 7, 20].map(streakBonus), [0, 0, 100, 200, 300, 500, 500]);
});

const roster = [
  { seat: 1, userId: 'u1', username: 'ann' },
  { seat: 2, userId: 'u2', username: 'bob' },
];
const gateFor = (q) => ({ startedAt: 0, timeLimitMs: 10_000, correctIndex: q.correctIndex ?? -1, optionCount: q.options?.length ?? 1 });

test('streaks build across questions, reset on a miss, and double rounds double the base points only', () => {
  const q = { type: 'choice', text: 't', options: ['a', 'b'], correctIndex: 0, timeLimit: 10 };
  let scores = {};
  for (let k = 0; k < 3; k++) {
    const r = scoreQuestion({
      k, question: q, gate: gateFor(q), roster, prevScores: scores, playerCount: 2,
      answers: [{ seat: 1, choice: 0, at: 0 }, { seat: 2, choice: k === 1 ? 1 : 0, at: 0 }],
    });
    scores = r.scores;
  }
  assert.deepEqual(scores[1], [3100, 3, 1100, 3, 3, 100], 'ann: 3 instant right answers + 100 streak bonus');
  assert.deepEqual(scores[2], [2000, 2, 1000, 1, 1, 0], 'bob missed question 2, so his streak restarted');

  const dq = { ...q, double: true };
  const r = scoreQuestion({ k: 3, question: dq, gate: gateFor(dq), roster, prevScores: scores, playerCount: 2, answers: [{ seat: 1, choice: 0, at: 10_000 }] });
  assert.equal(r.scores[1][2], 500 * 2 + 200, 'slowest right answer doubled, plus the 4-in-a-row bonus');
  assert.equal(r.scores[2][3], 0, 'no answer ends a streak');
  const mine = myChoiceFor(r.result, r.scores, 1);
  assert.deepEqual(mine, { choice: 0, answer: null, correct: true, partial: false, gained: 1200, bonus: 200, streak: 4 });
  assert.equal(myChoiceFor(r.result, r.scores, 2), null);
});

test('the reveal names the fastest right answer, the biggest climber and the popular typed answers', () => {
  const tq = Q.prepareQuestion({ type: 'type', text: 'Capital of France?', answers: ['Paris'], timeLimit: 10 });
  const prev = { 1: [3000, 3, 0, 3, 3, 0], 2: [100, 0, 0, 0, 0, 0], 3: [2500, 2, 0, 0, 2, 0] };
  const three = [...roster, { seat: 3, userId: 'u3', username: 'cat' }];
  const r = scoreQuestion({
    k: 4, question: tq, gate: gateFor(tq), roster: three, prevScores: prev, playerCount: 3,
    answers: [
      { seat: 1, answer: 'London', at: 1000 },
      { seat: 2, answer: 'paris', at: 4000 },
      { seat: 3, answer: 'Pariss', at: 2000 },
    ],
  });
  assert.equal(r.result.rightCount, 2);
  assert.deepEqual(r.result.fastest, { username: 'cat', ms: 2000 });
  assert.equal(r.result.answerText, 'Paris');
  assert.deepEqual(r.result.summary.guesses.map((g) => [g.text, g.count, g.correct]), [['London', 1, false], ['paris', 1, true], ['Pariss', 1, true]]);
  const byName = Object.fromEntries(r.board.map((row) => [row.username, row]));
  assert.equal(byName.cat.move, 1, 'cat overtook ann');
  assert.equal(byName.ann.move, -1);
  assert.equal(byName.ann.streak, 0);
  assert.deepEqual(r.result.climber, { username: 'cat', move: 1, rank: 1 });
  assert.deepEqual(myChoiceFor(r.result, r.scores, 1), { choice: null, answer: 'London', correct: false, partial: false, gained: 0, bonus: 0, streak: 0 });
});

test('number questions: closest guess and average, partial points for close misses', () => {
  const nq = Q.prepareQuestion({ type: 'number', text: 'Bones?', answer: 206, tolerance: 0, timeLimit: 10 });
  const r = scoreQuestion({
    k: 0, question: nq, gate: gateFor(nq), roster, playerCount: 2,
    answers: [{ seat: 1, answer: 200, at: 0 }, { seat: 2, answer: 103, at: 0 }],
  });
  assert.deepEqual(r.result.summary, { average: 151.5, closest: { username: 'ann', value: 200 } });
  assert.equal(r.scores[1][2], Math.round(500 * (1 - 6 / 206)));
  assert.equal(r.scores[2][2], 250);
  assert.equal(r.result.marks[1], 2, 'a close miss is marked partly right');
  assert.equal(r.result.answerText, '206');
});

test('double rounds: the last question plus about 1 in 5 others, never the first', () => {
  assert.deepEqual([...doubleRounds(1)], []);
  assert.deepEqual([...doubleRounds(2)], [1]);
  for (let i = 0; i < 100; i++) {
    const d = doubleRounds(10);
    assert.ok(d.has(9) && !d.has(0));
    assert.equal(d.size, 2);
  }
});

test('awards pick the longest streak and the most right answers', () => {
  const board = [
    { username: 'ann', rank: 1, correctCount: 4, bestStreak: 2 },
    { username: 'bob', rank: 2, correctCount: 5, bestStreak: 5 },
  ];
  assert.deepEqual(awardsOf(board), { streak: { username: 'bob', n: 5 }, sharp: { username: 'bob', n: 5 } });
  assert.deepEqual(awardsOf([{ username: 'x', rank: 1, correctCount: 0, bestStreak: 0 }]), { streak: null, sharp: null });
});
