// Pure builders for everything the engine sends to browsers (protocol 2), plus the pure game rules the engine and its
// unit tests share. No I/O here: the inputs are the plain items described in lib/gamedata.js, e.g.
//   header  GamesTable item {code, status, version, hostId, total, qIndex, playerCount, endsAt, acceptUntil, ...}
//   member  {userId, username, seat, presenter, conns: Set<connectionId>}
//   gate    {k, startedAt, endsAt, acceptUntil, correctIndex, optionCount, timeLimitMs, expected, answered, seats: Set<seat>}
//   scores  {"<seat>": [score, correctCount, lastGain]}
// Never put a question's correctIndex into anything shown before its reveal.
import { calculateScore, rankPlayers } from './scoring.js';

export const PROTOCOL = 2;
export const LOBBY_LIST_SIZE = 24; // players (not the host) see this many of the most recent joiners
export const TOP_N = 10;
export const STUCK_MS = 8000; // a phase this far past its deadline lost its timer: the next visitor un-sticks it
export const START_STUCK_MS = 10_000; // the lobby gate closed this long ago but the game never started
const LIVE = new Set(['lobby', 'question', 'reveal']);

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// ---------- game rules ----------
/** In progress (or a lobby that hasn't expired). */
export const isLive = (h, now = Date.now()) =>
  !!h && LIVE.has(h.status) && !(h.status === 'lobby' && now > h.lobbyExpiresAt);
export const isLiveStatus = (status) => LIVE.has(status);
export const isQuestionAt = (h, k) => h?.status === 'question' && h.qIndex === k;
export const isRevealAt = (h, k) => h?.status === 'reveal' && h.qIndex === k;

/** Why a game is overdue for its next phase (its timer was lost), or null. `lobby` is the lobby gate item. */
export function stuckReason(h, lobby, now) {
  if (!h) return null;
  if (h.status === 'question' && now > (h.acceptUntil ?? h.endsAt) + STUCK_MS) return 'question';
  if (h.status === 'reveal' && now > h.revealEndsAt + STUCK_MS) return 'reveal';
  // Only a gate closed by start (it stamps closedAt); cancel closes it without one and must never start the game.
  if (h.status === 'lobby' && lobby?.open === false && lobby.closedAt && now > lobby.closedAt + START_STUCK_MS) return 'start';
  if (h.status === 'ended' && !h.resultsSaved) return 'end';
  return null;
}

/** Label shown in the lobby and match history, e.g. "Science, History" or "Flags, Sports + 3 more". */
export function categoryLabel(cats) {
  if (!cats.length) return null;
  return cats.length <= 3 ? cats.join(', ') : `${cats.slice(0, 2).join(', ')} + ${cats.length - 2} more`;
}

// ---------- members ----------
/** Every member item is a player except the presenter (a host who doesn't play). */
export const isPlayer = (m) => !!m && m.presenter !== true;
export const rosterOf = (members) => members.filter(isPlayer);
export const connIds = (m) => [...(m?.conns ?? [])];
export const isConnected = (m) => connIds(m).length > 0;
/** The host (playing or not) sees the whole lobby; players see the most recent joiners. */
export const seesAllPlayers = (header, m) => m?.userId === header.hostId || m?.presenter === true;
/** Seats counted at a question gate (a number set, absent until the first answer). */
export const seatsOf = (gate) => new Set([...(gate?.seats ?? [])].map(Number));

const tag = (h) => ({ v: h.version, code: h.code });

const gameInfo = (h) => ({
  status: h.status,
  hostId: h.hostId,
  hostName: h.hostName,
  hostPlays: !!h.hostPlays,
  category: h.category ?? null,
  total: h.total,
});

// ---------- lobby ----------
/** Newest joiners first. `all: false` keeps the LOBBY_LIST_SIZE most recent. */
export function lobbyPlayers(members, { all = false } = {}) {
  const newestFirst = rosterOf(members).sort((a, b) => b.seat - a.seat);
  return (all ? newestFirst : newestFirst.slice(0, LOBBY_LIST_SIZE)).map((m) => ({
    userId: m.userId,
    username: m.username,
    connected: isConnected(m),
  }));
}

/** room:state (lobby only). */
export function roomState(header, members, { all = false } = {}) {
  return {
    ...tag(header),
    ...gameInfo(header),
    status: 'lobby',
    playerCount: rosterOf(members).length,
    players: lobbyPlayers(members, { all }),
  };
}

// ---------- question ----------
/** question:show. `timing` = {k, endsAt, acceptUntil} (the gate, or the header's copy of it). */
export function questionShow(header, question, timing, serverNow) {
  return {
    ...tag(header),
    index: timing.k,
    total: header.total,
    text: question.text,
    options: question.options,
    timeLimit: question.timeLimit,
    endsAt: timing.endsAt,
    acceptUntil: timing.acceptUntil,
    serverNow,
    playerCount: header.playerCount,
  };
}

/** answer:count. */
export const answerCount = (header, k, answered) => ({ ...tag(header), index: k, answered, total: header.playerCount });

// ---------- scoring ----------
/** Every roster player as a leaderboard row (with `seat`), best first, competition-ranked (ties share a rank). */
export function rankRows(roster, scores = {}) {
  const rows = roster.map((m) => {
    const [score = 0, correctCount = 0, lastGain = 0] = scores?.[m.seat] ?? [];
    return { seat: m.seat, userId: m.userId, username: m.username, score, correctCount, lastGain };
  });
  return rankPlayers(rows);
}

/** The row as sent to browsers. */
export const publicRow = (r) =>
  r ? { userId: r.userId, username: r.username, score: r.score, correctCount: r.correctCount, lastGain: r.lastGain, rank: r.rank } : null;

/**
 * Scores question k. `answers` are the answer items whose seat the gate counted; `roster` the players now in the game;
 * `prevScores` the cumulative scores before k. Returns the new cumulative scores (every roster seat), the ranked board
 * and the result item for k. Answers from seats no longer in the roster (kicked) still count in the option totals.
 */
export function scoreQuestion({ k, question, gate, answers, roster, prevScores = {}, playerCount }) {
  const bySeat = new Map(answers.map((a) => [Number(a.seat), a]));
  const scores = {};
  for (const m of roster) {
    const [score = 0, correctCount = 0] = prevScores?.[m.seat] ?? [];
    const a = bySeat.get(m.seat);
    const correct = !!a && a.choice === gate.correctIndex;
    // Time is measured from API Gateway's arrival stamp, so a slow Lambda never costs a player points.
    const elapsedMs = a ? clamp(a.at - gate.startedAt, 0, gate.timeLimitMs) : 0;
    const gained = a ? calculateScore({ correct, elapsedMs, timeLimitMs: gate.timeLimitMs }) : 0;
    scores[m.seat] = [score + gained, correctCount + (correct ? 1 : 0), gained];
  }
  const optionCounts = Array.from({ length: gate.optionCount }, () => 0);
  const choices = {};
  for (const a of answers) {
    if (a.choice >= 0 && a.choice < optionCounts.length) optionCounts[a.choice] += 1;
    choices[a.seat] = a.choice;
  }
  const board = rankRows(roster, scores);
  return {
    scores,
    board,
    result: {
      k,
      correctIndex: gate.correctIndex,
      text: question.text,
      options: question.options,
      optionCounts,
      answeredCount: answers.length,
      playerCount,
      top10: board.slice(0, TOP_N).map(publicRow),
      choices,
    },
  };
}

/** A player's row straight from the scores item: rank = 1 + players with a strictly higher score. */
export function rowFromScores(scores, member) {
  const [score = 0, correctCount = 0, lastGain = 0] = scores?.[member.seat] ?? [];
  const higher = Object.values(scores ?? {}).filter((s) => s[0] > score).length;
  return { userId: member.userId, username: member.username, score, correctCount, lastGain, rank: higher + 1 };
}

/** What this seat answered at question `result.k`, or null if it didn't answer. */
export function myChoiceFor(result, scores, seat) {
  const choice = result?.choices?.[seat];
  if (choice === undefined || choice === null) return null;
  return { choice, correct: choice === result.correctIndex, gained: scores?.[seat]?.[2] ?? 0 };
}

/** me + myChoice for one viewer (a presenter gets nulls). */
export function viewerOf(member, { result, scores, board } = {}) {
  if (!isPlayer(member)) return { me: null, myChoice: null };
  const row = board ? board.find((r) => r.seat === member.seat) : null;
  return {
    me: board ? publicRow(row) : rowFromScores(scores, member),
    myChoice: result ? myChoiceFor(result, scores, member.seat) : null,
  };
}

// ---------- reveal / end ----------
/** question:result for one viewer. `result` is the stored result item of the question. */
export function questionResult(header, result, { me = null, myChoice = null, serverNow }) {
  return {
    ...tag(header),
    index: result.k,
    total: header.total,
    text: result.text,
    options: result.options,
    correctIndex: result.correctIndex,
    optionCounts: result.optionCounts,
    answeredCount: result.answeredCount,
    playerCount: result.playerCount,
    revealEndsAt: header.revealEndsAt,
    serverNow,
    leaderboard: result.top10 ?? [],
    me,
    myChoice,
  };
}

/** game:end for one viewer. */
export const gameEnd = (header, leaderboard, me = null) => ({
  ...tag(header),
  playerCount: header.playerCount,
  leaderboard,
  me,
});

/** game:cancelled. */
export const gameCancelled = (header) => ({ ...tag(header), reason: header.cancelReason || 'The game was cancelled.' });

// ---------- snapshots (create / join / hello acks) ----------
/** The part of every snapshot; the engine adds players / question / result / final for the phase. */
export function snapshotBase(header, { isPlayer: playing, playerCount }) {
  return { ...tag(header), ...gameInfo(header), playerCount: playerCount ?? header.playerCount ?? 0, isPlayer: !!playing };
}

/** Lobby snapshot for `viewer` from the members known (all of them, or just the viewer right after a join). */
export function lobbySnapshot(header, members, viewer, { playerCount } = {}) {
  return {
    ...snapshotBase(header, { isPlayer: isPlayer(viewer), playerCount: playerCount ?? rosterOf(members).length }),
    players: lobbyPlayers(members, { all: seesAllPlayers(header, viewer) }),
  };
}

/**
 * Question-phase snapshot. `answered` / `answerCount` are given both inside `question` and next to it, so a client can
 * read either. `gate` may be null (then nobody has answered yet as far as we know).
 */
export function questionSnapshot(header, question, gate, viewer, serverNow) {
  const k = header.qIndex;
  const answered = isPlayer(viewer) && seatsOf(gate).has(viewer.seat);
  const count = { index: k, answered: gate?.answered ?? 0, total: header.playerCount };
  const timing = { k, endsAt: header.endsAt, acceptUntil: header.acceptUntil ?? gate?.acceptUntil };
  return {
    ...snapshotBase(header, { isPlayer: isPlayer(viewer) }),
    question: { ...questionShow(header, question, timing, serverNow), answered, answerCount: count },
    answered,
    answerCount: count,
  };
}
