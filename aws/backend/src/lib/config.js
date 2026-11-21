// All runtime configuration comes from Lambda environment variables (set in template.yaml).
const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
};
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const env = {
  get usersTable() { return required('USERS_TABLE'); },
  get questionsTable() { return required('QUESTIONS_TABLE'); },
  get gamesTable() { return required('GAMES_TABLE'); },
  // Per-game items that many players write at once (players, answers, gates). See lib/game.js.
  get gamePlayTable() { return required('GAMEPLAY_TABLE'); },
  get connectionsTable() { return required('CONNECTIONS_TABLE'); },
  get resultsTable() { return required('RESULTS_TABLE'); },
  get rateLimitsTable() { return required('RATE_LIMITS_TABLE'); },
  get quizzesTable() { return required('QUIZZES_TABLE'); },
  get jwtSecret() {
    const s = required('JWT_SECRET');
    if (s.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
    return s;
  },
  // https://{apiId}.execute-api.{region}.amazonaws.com/{stage} - used to push messages to sockets
  get wsEndpoint() { return required('WS_ENDPOINT'); },
  get timerFunction() { return required('TIMER_FUNCTION'); },
  get revealMs() { return num('REVEAL_MS', 4000); },

  // ---- capacity ----
  get maxPlayers() { return num('MAX_PLAYERS', 250); },
  // Answers that reached API Gateway up to this long after the timer hit zero are still accepted (cold starts,
  // throttled resends). Raise it (e.g. 5000) while the account's Lambda concurrency quota is still low.
  get lateGraceMs() { return num('LATE_GRACE_MS', 1500); },
  // Lobby lists and "x / y answered" counts are pushed at most once per window per game.
  get broadcastWindowMs() { return num('BROADCAST_WINDOW_MS', 500); },

  // ---- abuse protection (sized so a whole classroom behind one Wi-Fi IP can sign up at once) ----
  get registerMaxPerIp() { return num('REGISTER_MAX_PER_IP', 500); }, // sign-ups per IP per hour
  get loginFailMaxPerIp() { return num('LOGIN_FAIL_MAX_PER_IP', 200); }, // failed logins per IP per 15 min
  get loginFailMaxPerEmail() { return num('LOGIN_FAIL_MAX_PER_EMAIL', 10); }, // failed logins per account per 15 min
};
