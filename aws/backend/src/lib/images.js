// Question images: "[image:/flags/fr.svg]" in a question's text shows that picture next to it.
//
// - Only the site's own flag pictures are allowed. A third-party URL would let a quiz author log the IP address of
//   every phone in every game that hosts their quiz (and the page's CSP only allows images from the site itself).
// - Players never see the real file name: "fr.svg" would give the answer away. When a game is created, every flag is
//   renamed to a per-deploy alias derived from the server secret (the frontend publish step uploads the flags under
//   the same aliases, and the local dev server serves them the same way). The alias is not guessable from the public
//   repository, so the file name says nothing about the country.
import crypto from 'node:crypto';
import { env } from './config.js';

export const IMAGE_MARKER = /\[image:([^\]]*)\]/g;
/** A flag file as written in the question bank: /flags/<name>.svg. */
const BANK_FLAG = /^\/flags\/([a-z0-9-]{1,40})\.svg$/i;
/** What the page agrees to load (bank names and aliases alike). Keep in sync with public/js/app.js safeImageUrl. */
export const SAFE_IMAGE_PATH = /^\/flags\/[A-Za-z0-9_-]{1,40}\.svg$/;

/** Every image path in a text is one the site serves itself. */
export const imagesAllowed = (text) => [...String(text ?? '').matchAll(IMAGE_MARKER)].every(([, p]) => SAFE_IMAGE_PATH.test(p.trim()));

/** The published name (without .svg) of the flag file `name` ("fr"), for this deploy's secret. */
export function imageAlias(name, secret = env.jwtSecret) {
  return crypto.createHmac('sha256', secret).update(`quibble-image:${String(name).toLowerCase()}`).digest('base64url').slice(0, 16);
}

/** Question text as players receive it: flags under their alias, any other image marker removed. */
export function maskImages(text, secret = env.jwtSecret) {
  return String(text ?? '').replace(IMAGE_MARKER, (_, raw) => {
    const m = BANK_FLAG.exec(raw.trim());
    return m ? `[image:/flags/${imageAlias(m[1], secret)}.svg]` : '';
  });
}

/**
 * The bytes published under an alias: the original SVG plus a comment derived from the secret, so the file can't be
 * matched to the original in the public repository by its hash either.
 */
export function aliasedSvg(svg, name, secret = env.jwtSecret) {
  const tag = crypto.createHmac('sha256', secret).update(`quibble-image-body:${String(name).toLowerCase()}`).digest('hex').slice(0, 24);
  return `${String(svg).trimEnd()}\n<!-- ${tag} -->\n`;
}
