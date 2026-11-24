// Structural checks of the lobby's QR code generator (public/js/qr.js). Decoding was verified with jsQR for
// versions 1-19 when it was written; these tests keep the basics from regressing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix } from '../../public/js/qr.js';

const finderAt = (m, x0, y0) => {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m[y0 + dy][x0 + dx] !== (ring !== 2)) return false;
    }
  }
  return true;
};

test('QR codes grow with the text and carry the three finder patterns', () => {
  const link = 'https://quibble-frontendbucket-xbdspxx14ytn.s3.ap-south-1.amazonaws.com/play.html?code=ABC123';
  for (const [text, version] of [['A', 1], [link, 6], ['x'.repeat(200), 10], ['ü'.repeat(150), 13]]) {
    const m = qrMatrix(text);
    const size = version * 4 + 17;
    assert.equal(m.length, size, `${text.length} chars -> version ${version}`);
    assert.ok(m.every((row) => row.length === size));
    assert.ok(finderAt(m, 0, 0) && finderAt(m, size - 7, 0) && finderAt(m, 0, size - 7));
    assert.equal(m[size - 8][8], true, 'the dark module');
  }
});

test('the same text always gives the same code', () => {
  assert.deepEqual(qrMatrix('http://localhost:5050/play.html?code=XYZ789'), qrMatrix('http://localhost:5050/play.html?code=XYZ789'));
});

test('text that cannot fit is refused', () => {
  assert.throws(() => qrMatrix('x'.repeat(3000)), /Too long/);
});

test('a scanned QR code yields a game code, never a link to follow', async () => {
  const { codeFromScan } = await import('../../public/js/common.js');
  assert.equal(codeFromScan('https://quibble.example/play.html?code=abc234'), 'ABC234');
  assert.equal(codeFromScan('http://localhost:5050/play.html?code=XK7P2Q'), 'XK7P2Q');
  assert.equal(codeFromScan('  xk7p2q \n'), 'XK7P2Q'); // a bare code
  assert.equal(codeFromScan('https://evil.example/login'), null);
  assert.equal(codeFromScan('javascript:alert(1)//?code=ABC234'), null);
  assert.equal(codeFromScan('https://quibble.example/play.html?code=ABC23'), null); // too short
  assert.equal(codeFromScan('WIFI:S:home;T:WPA;P:secret;;'), null);
  assert.equal(codeFromScan(''), null);
  assert.equal(codeFromScan(null), null);
});
