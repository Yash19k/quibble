// Unit tests for the QA/security pass: question images, staff-looking usernames, strict game codes, idempotent quiz
// ids. No AWS or dev server needed:  node --test aws/tests/security.unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'x'.repeat(48);

const { imagesAllowed, imageAlias, maskImages, aliasedSvg } = await import('../backend/src/lib/images.js');
const { questionSchema, registerSchema, wsSchemas } = await import('../backend/src/lib/schemas.js');
const { quizIdFor } = await import('../backend/src/lib/quizzes.js');

const SECRET = 'y'.repeat(48);

// ---------- question images ----------
test('only the site\'s own flag images are allowed in question text', () => {
  assert.equal(imagesAllowed('Which flag?\n[image:/flags/fr.svg]'), true);
  assert.equal(imagesAllowed('No image at all'), true);
  for (const bad of ['https://tracker.example/p.gif', '//evil.example/x.svg', '/\evil.example/p.png', '/flags/../x.svg',
    'javascript:alert(1)', 'data:image/svg+xml,<svg/>', '/img/fr.png']) {
    assert.equal(imagesAllowed(`Q [image:${bad}]`), false, bad);
  }
  const q = (text) => questionSchema.safeParse({ text, options: ['a', 'b'], correctIndex: 0 }).success;
  assert.equal(q('Which flag? [image:/flags/de.svg]'), true);
  assert.equal(q('Which flag? [image:https://tracker.example/p.gif]'), false);
});

test('players get flags under a secret alias and never a third-party image', () => {
  const masked = maskImages('Which country?\n[image:/flags/fr.svg]', SECRET);
  assert.doesNotMatch(masked, /fr\.svg/);
  assert.equal(masked, `Which country?\n[image:/flags/${imageAlias('fr', SECRET)}.svg]`);
  assert.match(masked, /\[image:\/flags\/[A-Za-z0-9_-]{16}\.svg\]/);
  assert.notEqual(imageAlias('fr', SECRET), imageAlias('fr', 'z'.repeat(48)), 'aliases change with the secret');
  assert.notEqual(imageAlias('fr', SECRET), imageAlias('de', SECRET));
  // A stored quiz from before the allow-list: its tracking image is removed at game time.
  assert.equal(maskImages('Look [image:https://tracker.example/p.gif]', SECRET), 'Look ');
  assert.equal(maskImages('No image', SECRET), 'No image');
});

test('published flag files differ from the originals in the public repository', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n';
  const out = aliasedSvg(svg, 'fr', SECRET);
  assert.notEqual(out, svg);
  assert.ok(out.startsWith(svg.trimEnd()));
  assert.notEqual(out, aliasedSvg(svg, 'fr', 'z'.repeat(48)));
});

// ---------- accounts ----------
test('self sign-up refuses names that pass for staff', () => {
  const ok = (username) => registerSchema.safeParse({ email: 'a@b.co', username, password: 'abcdefgh' }).success;
  for (const name of ['admin', 'Admin_2', 'TheAdmin', 'QuibbleBot', 'support_team', 'mod', 'mod_squad', 'system7', 'Staff']) {
    assert.equal(ok(name), false, name);
  }
  for (const name of ['alice', 'supportive', 'modern', 'systematic', 'sys99', 'staffy']) assert.equal(ok(name), true, name);
});

// ---------- WebSocket input ----------
test('game codes are 6 letters or digits, nothing else', () => {
  const join = (code) => wsSchemas['room:join'].safeParse({ code });
  assert.deepEqual(join(' abc234 ').data, { code: 'ABC234' });
  for (const bad of ['ABC#Q1', 'ABCDEFG', 'ABC', 'AB CD1', 'ÄBCDEF']) assert.equal(join(bad).success, false, bad);
  assert.equal(wsSchemas['answer:submit'].safeParse({ choice: 1, code: 'X#P0AB' }).success, false);
});

// ---------- quizzes ----------
test('a resent quiz create maps to the same id, and only for the same owner', () => {
  const a = quizIdFor('user-1', 'req-abcdefgh');
  assert.equal(a, quizIdFor('user-1', 'req-abcdefgh'));
  assert.notEqual(a, quizIdFor('user-2', 'req-abcdefgh'));
  assert.notEqual(a, quizIdFor('user-1', 'req-other123'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});
