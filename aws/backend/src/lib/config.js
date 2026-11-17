// All runtime configuration comes from Lambda environment variables (set in template.yaml).
const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
};

export const env = {
  get usersTable() { return required('USERS_TABLE'); },
  get questionsTable() { return required('QUESTIONS_TABLE'); },
  get gamesTable() { return required('GAMES_TABLE'); },
  get connectionsTable() { return required('CONNECTIONS_TABLE'); },
  get resultsTable() { return required('RESULTS_TABLE'); },
  get rateLimitsTable() { return required('RATE_LIMITS_TABLE'); },
  get jwtSecret() {
    const s = required('JWT_SECRET');
    if (s.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
    return s;
  },
  // https://{apiId}.execute-api.{region}.amazonaws.com/{stage} - used to push messages to sockets
  get wsEndpoint() { return required('WS_ENDPOINT'); },
  get timerFunction() { return required('TIMER_FUNCTION'); },
  get revealMs() { return Number(process.env.REVEAL_MS) || 4000; },
  get authRateMax() { return Number(process.env.AUTH_RATE_MAX) || 20; },
};
