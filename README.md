# Quibble

**Quibble is a real-time multiplayer quiz game built entirely on serverless AWS.**
One person hosts a game and gets a 6-character code, up to 250 players join from their phones, and everyone races the same countdown. Faster correct answers score more points.

`API Gateway (WebSocket + HTTP)` · `AWS Lambda` · `Amazon DynamoDB` · `Amazon S3` · `Amazon CloudWatch` · `AWS IAM`

---

## Features

- **Live multiplayer** over WebSockets for up to 250 players per game: lobby, synchronized countdown, per-question results, final podium
- **The server decides everything.** It holds the answers, runs the clock, measures answer speed and scores every answer. The browser only ever sends "I picked option 2"
- **Speed scoring:** 1000 points for an instant correct answer, sliding down to 500 at the buzzer
- **Reconnect-safe and self-healing:** refresh or drop your connection mid-game and you land back in the same question; a missed update is recovered automatically
- **Five question types:** multiple choice, true/false, *type it* (forgives capitals, accents and small typos), *put in order* (partly right still scores) and *closest number* (close guesses earn points; the reveal names the closest guess)
- **Streaks and double points:** 3+ right answers in a row earn a growing bonus (+100 up to +500); hosts can switch on double-points rounds (always the final question)
- **Richer results:** answer breakdown, how many got it right, the fastest right answer, the biggest climber, rank arrows and popular typed answers; a podium and awards at the end
- **Join by QR code:** the lobby draws a QR code of the join link (generated in the browser, no CDN), and the Join card has a **Scan** button that reads it with the phone's camera (the browser's `BarcodeDetector`, or the bundled jsQR decoder on iPhone), with a photo upload when there is no camera. A scan only ever takes the 6-character code; it never opens the scanned link
- **Emoji reactions** in the lobby, on results and the final screen, batched on the server so a full room costs about one push a second
- **Big-screen mode (optional):** the host's screen becomes a projector view (huge question, timer, animated leaderboard) and phones become answer pads
- **My quizzes:** anyone can build their own quiz with any question type, host it, or share a link so others can host it (they never see the answers)
- **Leaderboards** (all-time and this week) and a personal match history
- **Admin console** (`admin.html`, admins only): a live dashboard, a live-games monitor that can end any game, full game history, player accounts (rename, ban with a reason, kick, sign out everywhere, reset password, delete), the question bank (bulk delete, JSON import/export, category rename, Open Trivia DB import), player-quiz moderation, leaderboards, a site-wide announcement banner, rate-limit counters, system health and an audit log of every admin action. See [Admin console](#admin-console)
- **Security:** bcrypt passwords, signed JWTs, input validation on every REST call *and* every socket message, per-IP sign-up and failed-login limits (sized for a whole classroom on one Wi-Fi), a message budget per socket, API Gateway throttling, a strict Content-Security-Policy, least-privilege IAM roles. See [Security](#security)
- **Observability:** structured logs, custom game metrics, alarms and a CloudWatch dashboard, all created by the template
- **Email alerts:** uptime probes every minute, plus an email when the site goes down or comes back, when errors are logged, when a deploy fails, and on sensitive admin actions. See [Email alerts](#email-alerts)

## Architecture

```
                 ┌──────────── Amazon S3 (the frontend, over HTTPS)
 Browser ────────┤
                 ├── HTTPS ──► API Gateway HTTP API ──► Lambda: api ─────────────────┐
                 │                                       (auth, leaderboards, admin)  │
                 └── WSS ────► API Gateway WebSocket API                              ▼
                                 $connect    ──► Lambda: ws-connect           Amazon DynamoDB
                                 $default    ──► Lambda: ws-message  ──────►  Users · Questions
                                 $disconnect ──► Lambda: ws-disconnect        Games · GamePlay · Quizzes
                                                    │  ▲                      Connections · Results
                     async invoke at deadline ──────┘  │ PostToConnection     RateLimits · Admin
                                 Lambda: game-timer ───┘ (pushes events to every player)

 Amazon CloudWatch  log groups (14-day retention) · alarms · custom metrics · dashboard
 AWS IAM            one role per Lambda, scoped to exactly the tables and APIs it uses
```

| Service | What it does in Quibble |
|---|---|
| **API Gateway WebSocket API** | Persistent connection for gameplay: `$connect` authenticates, `$default` handles game actions, `$disconnect` marks players offline |
| **API Gateway HTTP API** | REST endpoints for login, leaderboards, history and the admin panel |
| **AWS Lambda** | Five Node.js 22 functions on arm64: `api`, `ws-connect`, `ws-message`, `ws-disconnect`, `game-timer` |
| **Amazon DynamoDB** | Nine on-demand tables (Quizzes holds the quizzes players build; Admin holds the audit log and the announcement). TTL cleans up old games, game-play items, sockets, rate-limit counters and year-old audit entries |
| **Amazon S3** | Hosts the static frontend, served over HTTPS |
| **Amazon CloudWatch** | Logs, alarms, a dashboard and custom metrics in the `Quibble` namespace |
| **AWS IAM** | Least-privilege execution role per function |

### How a game stays consistent without a server

Lambdas are stateless and short-lived, so a game can't live in memory and can't use `setTimeout`. And 250 people answering in the same instant must not all write the same database item.

- **State is split by who writes it.** The `Games` table holds one small *header* per game (status, current question, deadlines, a `version` number) that changes only when the game moves to a new phase. Everything players write at the same moment lives in the `GamePlay` table, where each kind of item has its own partition key, so no key gets more than one burst:

  | Partition key | Items |
  |---|---|
  | `<code>#P` | one per member: seat number and open sockets |
  | `<code>#L` | the lobby gate: seat counter and player limit |
  | `<code>#Q` | one gate per question: deadline, answered count, the seats that answered |
  | `<code>#A#<k>` | one item per answer to question k |
  | `<code>#S` / `<code>#R` | running scores / each question's result |
  | `<code>#M`, `<code>#B` | the game's questions / broadcast and recovery leases |

- **Answers** are two small conditional writes and no reads: store the answer (only if it isn't there yet, so a resend keeps its first arrival time), then add the seat to the question's gate (only while the question is open and if that seat hasn't counted yet). Speed is measured from API Gateway's arrival time, so a slow Lambda never costs a player points. Answers that arrive up to `LATE_GRACE_MS` (1.5 s) after the buzzer still count.
- **Phase changes** (open a question, show its result, end the game) are DynamoDB transactions guarded by the header's `version`: when several Lambdas try the same step, exactly one wins and the others do nothing.
- **Time:** whoever moves a game into a new phase invokes the `game-timer` Lambda asynchronously with that phase's deadline. While a question is open the timer pushes "x of y answered" about once a second; at the deadline it scores the question; after the reveal it opens the next one. If everyone answers early, the question closes at once.
- **Push:** Lambdas send events to players' browsers through the API Gateway Management API (`PostToConnection`), addressed to the sockets listed on each member item. Every event carries the game's `version`, so browsers ignore stale or repeated ones.
- **Self-healing:** pushes and `$disconnect` events can get lost. A browser that waits too long for the next phase sends `sync` and gets a full snapshot of the game; if a timer died, that `sync` also restarts it (under a short lease, so 250 browsers don't all try).
- **Abandoned games end on their own.** An EventBridge schedule sends the `game-timer` Lambda `{"kind":"sweep"}` every 2 minutes. It cancels a game in play that everyone (host included) left 3 minutes ago, a lobby that has been empty for 10 minutes, a lobby past its 3-hour limit, a phase stuck more than 2 minutes past its deadline that un-sticking can't move, and anything live for over 4 hours; it tries to un-stick overdue games first. "Left" means no socket that showed life in the last 11 minutes (browsers ping every 5), so a lost `$disconnect` can't keep a dead game open. Locally the dev server runs the same sweep (`LOCAL_SWEEP_MS`).

## Run it locally (no AWS account needed)

Requires Node.js 22+ and Docker.

```bash
npm install
docker run -d -p 8000:8000 --name quibble-dynamodb amazon/dynamodb-local
npm run dev            # http://localhost:5050   (admin@example.com / admin12345)
```

`npm run dev` runs the **real Lambda handlers** against DynamoDB Local, with a small Node server standing in for API Gateway. It creates the tables and sample questions on first start. Open two browser windows (one private) to play against yourself. Optional settings are listed in `.env.example`.

```bash
npm test               # unit tests (scoring, game views, leaderboards, rate limits)
npm run test:e2e       # end-to-end games over real WebSockets (needs npm run dev running)
npm run test:load      # 200 players in one game (needs npm run dev running; see "Capacity & scaling")
```

## Deploy to AWS

**One-time setup**

1. Install the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) (1.123 or newer).
2. Run `aws configure` with an IAM user or SSO profile that can create the resources, and pick a region.
3. Ask AWS to raise the account's Lambda concurrency to the standard 1,000 (free): `npm run quota:lambda -- --request`. New accounts get only 10; see [Capacity & scaling](#capacity--scaling).

**Deploy**

```bash
npm run preflight      # checks SAM CLI, credentials, region, Lambda quota and live games
npm run deploy         # sam build + sam deploy + upload the frontend to S3
npm run seed           # first time only: admin account + the sample questions
npm run deploy -- AlertEmail=you@example.com   # once: email alerts (see Monitoring > Email alerts)
```

The deploy prints the **`WebsiteUrl`**, an HTTPS link like `https://<bucket>.s3.<region>.amazonaws.com/index.html`. Share that one. The old plain-HTTP website address is still there (`WebsiteHttpUrl`), but browsers warn about HTTP pages. The HTTPS address has no index page, so links always name a file: `/index.html`, `/play.html?code=ABC123`.

Run `npm run deploy` again to ship changes. If only the frontend changed, `npm run publish` is enough. Template parameters go after `--` as `Name=value` (for example `npm run deploy -- LateGraceMs=5000 MaxPlayers=250`) and stay set for later deploys until you change them.

- The login-token secret is generated on the first deploy and kept in `aws/.jwt-secret`, which is git-ignored.
- Because the site is public, `npm run seed` generates a strong admin password unless `.env` sets one of 10 or more characters.
- **If the deploy fails on the S3 bucket policy**, S3 *Block Public Access* is on for your whole account. Turn off "block public access … through new public bucket policies" in the S3 console, then deploy again.

**Test the live deployment**

```bash
QA_API=<HttpApiUrl> QA_WS=<WebSocketUrl> ADMIN_PASSWORD=<admin password> npm run test:e2e
```

**Tear down:** empty the website bucket, then run `sam delete --stack-name quibble`.

## Capacity & scaling

**Targets**, checked by the load test:

- 200 people sign up at the same moment from one network (a classroom or venue Wi-Fi), and all succeed.
- 250 players (the `MaxPlayers` parameter) join one game within seconds and answer the same question within the same 100 ms: every answer is accepted and scored, with no errors shown.
- Every DynamoDB partition key stays below ~30% of its limits (1,000 writes/s and 3,000 reads/s) in any burst.
- Every player sees every phase; a lost update heals itself within seconds.

**How much it holds** (production settings: Lambda quota 1,000, the template's stage throttles)

| | Capacity | What runs out first |
|---|---|---|
| Players in one game | **250** (`MaxPlayers`), load-tested with reconnect storms and zero errors | Per game, the busiest DynamoDB keys peak around 25% of their per-key limit. `MaxPlayers` goes up to 1,000, but anything above 250 is untested (the question gate key grows by about 1 write/s per player) |
| Sign-ups at the same moment | **200+** tested locally; on AWS hundreds per second | `REGISTER_MAX_PER_IP`: **500 per hour per network**. Raise it for a bigger venue where everyone shares one Wi-Fi |
| Players online at once | **About 5,000 comfortably** (20 full games). The ceiling is around 10,000 | The WebSocket stage throttle (1,000 messages/s, 2,000 burst) when many games open a question at the same moment; API Gateway's account limit of 10,000 requests/s, which includes the pushes (a 250-player game makes about 130/s); on-demand DynamoDB's warm capacity (about 4,000 writes/s) at the first very big event |
| Games running at once | **About 800** of any size | Each running game keeps one game-timer Lambda busy for its whole duration, out of the 1,000-slot quota. Lobbies don't count |
| Mass reconnect (a venue's Wi-Fi drops) | Every socket is back within a few seconds for a few thousand players | 500 new WebSocket connections/s per account. The page backs off with jitter (up to 5 s, then 20 s after 5 failed tries) so the crowd spreads out |
| Accounts and history | Tens of thousands of accounts, about 100,000 game results | Leaderboard refreshes (after every game) and admin pages scan whole tables. Beyond that, keep running totals with DynamoDB Streams |

The per-game numbers come from the local load test. The AWS-wide numbers come from AWS's published limits combined with the per-game load the test measures. To confirm them on AWS, deploy a separate test stack (`QUIBBLE_STACK=quibble-loadtest npm run deploy`) and point the load test at it with `--api`/`--ws`. Never point it at the live stack.

To go past about 10,000 players online: raise the stage throttles in `template.yaml`, ask AWS for higher API Gateway limits, and set DynamoDB warm throughput on the GamePlay and Connections tables before the event.

**Limits that matter**

| Limit | Value | At the limit |
|---|---|---|
| Lambda concurrent executions (per account and region, shared by every function) | **10** on new accounts; standard 1,000 | invocations are throttled; the page retries, so things slow down |
| API Gateway, per account | 10,000 requests/s (5,000 burst), 500 new WebSocket connections/s | throttled requests are retried by the page |
| Stage throttles set by the template | HTTP API and WebSocket API: 1,000 requests/s, 2,000 burst each | 429, retried |
| WebSocket connections | 32 KB frames, 10 min idle, 2 h maximum | the page reconnects and resyncs |
| DynamoDB, per partition key | 1,000 writes/s, 3,000 reads/s | the data model keeps every key far below |

**The Lambda quota is the one to fix before a big game.** With 10 concurrent executions, 250 players answering at once queue behind 10 slots. Nothing is lost (API Gateway refuses the extra requests and the page resends them with backoff), but phases show up seconds late, and answers sent in the final moments can miss the deadline. Raising it to the standard 1,000 is free and usually approved within a day:

```bash
npm run quota:lambda                 # current value and any open request
npm run quota:lambda -- --request    # ask for 1,000 (Service Quotas code L-B99A9384)
```

Until it's raised, deploy with a longer answer grace period so late-arriving answers still count, and set it back afterwards:

```bash
npm run deploy -- LateGraceMs=5000   # while the quota is low
npm run deploy -- LateGraceMs=1500   # after the raise (the default)
```

The functions deliberately reserve no concurrency: a reservation carves slots out of the shared pool, and isn't possible at all on a 10-slot account.

**Load test locally.** The dev server can behave like a 10-slot account (throttled calls fail exactly as they do on AWS), drop some `$disconnect` events (AWS only tries its best to send them) and measure DynamoDB capacity per partition key (which DynamoDB Local doesn't limit):

```bash
# terminal 1 (or put these variables in .env)
LOCAL_LAMBDA_CONCURRENCY=10 LOCAL_DROP_DISCONNECT_PCT=10 LOCAL_TRACK_CAPACITY=1 npm run dev
# terminal 2
npm run test:load -- --players 200 --questions 12 --spread 0 --silent 10 --late 20 --drop 15
```

In PowerShell, set the variables first: `$env:LOCAL_LAMBDA_CONCURRENCY=10; $env:LOCAL_TRACK_CAPACITY=1; npm run dev`.

The load test signs up the players at once from one IP, has them join one game (plus a duplicate tab), plays every question with all of them answering in the same instant (`--silent` never answer, `--late` answer in the last half second, `--drop` % lose their connection for a few seconds mid-question), forces mass reconnects, and fails unless every request succeeded, every accepted answer was counted, every player saw every phase, results were saved and every partition key stayed under 30% of its limits. It prints p50/p95/max latencies.

| `LOCAL_LAMBDA_CONCURRENCY` exceeded on… | What the client sees (same as AWS) |
|---|---|
| an HTTP API call | `500 {"message":"Internal Server Error"}` |
| a WebSocket message | a frame `{"message":"Internal server error","connectionId":…,"requestId":…}` |
| a WebSocket connect | the connection is refused (browser close code 1006) |
| a game-timer invoke | the event is re-queued with 1, 2, 4 … s backoff (up to 30 s) |

Two endpoints show what happened: `GET /__local/stats` (invocations, throttles, dropped disconnects, timer re-queues) and `GET /__local/capacity` (peak DynamoDB units per second per table and per partition key, with `LOCAL_TRACK_CAPACITY=1`). Add `?reset=1` to start counting afresh.

## Before an event

- [ ] Lambda concurrency quota is 1,000: `npm run quota:lambda` (request it days ahead with `-- --request`)
- [ ] AWS SAM CLI 1.123 or newer: `sam --version`
- [ ] `npm run preflight` passes (use `-- --allow-degraded` only if you accept slower phases on a low quota)
- [ ] Deployed the latest version with `npm run deploy`; if the quota is still low, with `-- LateGraceMs=5000`
- [ ] Shared the **HTTPS** `WebsiteUrl` (`https://…amazonaws.com/index.html`), or a join link from the lobby (`…/play.html?code=ABC123`)
- [ ] The CloudWatch dashboard is open: Lambda concurrency and throttles, DynamoDB throttles
- [ ] No deploys while a game is running (preflight warns about live games)

## Admin console

Open `admin.html` (the **Admin** button in the game header) with an admin account. Every page reads live data from the API; every change is written to the audit log.

| Page | What you can see and do |
|---|---|
| **Overview** | Who is online and which games are live right now; sign-ups, games, active players and plays per day over 7, 30 or 90 days (in your time zone) against the previous period; top players, the question bank by category and type, the newest players, recent games and admin activity |
| **Live games** | Every lobby and running game, refreshed every 5 s. Open one to follow it question by question (who is online, standings, how many got each question right) or **end it** for everyone with a reason |
| **Game history** | Every stored game (finished games are kept 30 days, cancelled ones a day), searchable and filterable; each has its final standings, awards and per-question results |
| **Players** | Every account with games, points, join and last-login dates and online status; search, filter (online, admins, banned), sort, CSV export. A player's page has their stats, game history, quizzes and open connections, plus **rename**, **make / remove admin**, **ban with a reason** / unban, **kick from game**, **sign out everywhere**, **reset password** (shows a one-time temporary password) and **delete account** (with its results and quizzes) |
| **Question bank** | Search and filter by category and type, add / edit / delete, select and delete in bulk, **import a JSON file**, **export** the current filter, **rename or merge a category**, import from Open Trivia DB |
| **Player quizzes** | Every quiz players built, with owner and sharing; read one with its answers, **stop sharing** it or delete it |
| **Leaderboards** | The boards players see (all time / this week), with a button to recompute them |
| **Announcement** | One message (info or warning) shown above the game on every player's page until you take it down |
| **Activity log** | Who changed what and when, for every admin action (kept a year) |
| **Security** | The sign-up and failed-login counters of the current windows (account counters are matched back to a username), with a reset to let a blocked network or account in again |
| **System health** | API and database response times, open sockets, the runtime and game settings in force, and every DynamoDB table's size |

"Sign out everywhere" and "reset password" bump a session version stored on the account and carried in every login token, so exactly the tokens (and sockets) issued before it stop working; an admin can't demote, ban, sign out, reset or delete their own account.

## Monitoring

- **Dashboard** (the `DashboardUrl` output): games created, started, finished and cancelled, answers, Lambda concurrency and throttles (account-wide and per function), DynamoDB throttles and GamePlay capacity, WebSocket connections, API latency and errors, Lambda errors and duration, uptime probes, and a live table of recent error logs.
- **Alarms:** `quibble-health-check`, `quibble-error-logs`, `quibble-api-lambda-errors`, `quibble-websocket-lambda-errors` (connect, disconnect and messages), `quibble-game-timer-errors`, `quibble-http-api-5xx`, `quibble-lambda-throttles` (account-wide), `quibble-game-timer-events-dropped`, `quibble-game-timer-late`, read/write throttle alarms for the GamePlay and Games tables, and `quibble-monitor-errors`.
- **Logs Insights:** `fields @timestamp, msg, error.message | filter level = "error" | sort @timestamp desc`

### Email alerts

Give the stack an address once, then click **Confirm subscription** in the email AWS sends to it:

```bash
npm run deploy -- AlertEmail=you@example.com AlertTimeZone=Asia/Kolkata
npm run alerts:test     # sends a test email and says whether the address has confirmed
```

| You get an email when | How it's detected |
|---|---|
| **The site is down**: the website, the API + database or the WebSockets stop answering (and another email when they're back) | The monitor Lambda probes all three every minute: it loads `index.html`, calls `/api/health` (which reads DynamoDB), and opens a WebSocket handshake that a healthy `$connect` refuses with 401. Two failed minutes out of three trip `quibble-health-check`. |
| **Errors**: a handler logs an error, a Lambda crashes or times out, or the API answers 5xx | A metric filter counts `level: "error"` log lines (the handlers catch most errors, so Lambda's own `Errors` metric misses them), plus the Lambda error and 5xx alarms. The email quotes the matching log lines. |
| **Capacity problems**: Lambda or DynamoDB throttling, game timer events late or dropped | The existing alarms. |
| **A deploy fails** or rolls back, or a rollback gets stuck | An EventBridge rule on the stack's CloudFormation status events. The email names the resource that failed and why. |
| **Sensitive admin activity**: an admin role granted or removed, a player banned or deleted, a password reset, questions bulk-deleted | The admin audit log (`lib/alerts.js`). It's a tripwire in case an admin account falls into the wrong hands. |

Every alarm invokes the monitor function (`handlers/monitor.js`), which turns it into a plain-language email and sends it through the `AlertsTopic` SNS topic. If the monitor itself fails, `quibble-monitor-errors` emails CloudWatch's standard message straight through SNS. To add more recipients, subscribe them to the topic (the `AlertsTopicArn` output) in the SNS console. With `AlertEmail` empty, the alarms and probes still run, but nobody is emailed.

## Security

| Threat | What stops it |
|---|---|
| Password guessing | bcrypt (cost 10). Each attempt is taken from two budgets **before** the password is checked: 10 failed logins per account and 200 per IP per 15 minutes. The counters are bumped atomically, so a burst of parallel guesses can't get more than the limit through; a successful login hands its slot back. Admins can lift a block on the Security page. |
| One client flooding the WebSocket | Every message counts against its socket (fixed 10 s windows, kept on the connection record that each message reads anyway). Past 60 messages a window they are refused without doing any work; past 150 the socket is closed. A real player sends a handful per question. This protects the account's shared Lambda concurrency from a single script. |
| Cheating | The server holds the answer keys, runs the clock (API Gateway's arrival time) and scores everything; nothing in `question:show` reveals the answer. Flag pictures are published under a per-deploy alias derived from the server secret (`lib/images.js`), so the file name (`fr.svg`) no longer gives the answer away. |
| Tracking players through quiz images | Question images are limited to the site's own flags (`[image:/flags/xx.svg]`), on the server (validation, and stripped from stored quizzes when a game starts) and in the browser; the CSP only allows images from the site itself. |
| XSS | All dynamic text goes through `textContent`/`setAttribute` (`el()` in `common.js`, which also refuses string `on*` handlers and `javascript:` URLs). Every page has a CSP without inline scripts; `npm run publish` pins `connect-src` to this stack's two API hosts. |
| Staff impersonation | Self sign-up refuses names like `Admin_2`, `QuibbleSupport` or `mod_team` (an admin can still assign any name). |
| Malformed input | zod schemas on every body and socket message; game codes must be 6 letters/digits; path ids longer than 200 characters or with control characters are answered 404 before they reach DynamoDB (which would otherwise fail with a 500 and an error alert). |
| Duplicate writes on flaky networks | Game creation, quiz creation and joins are idempotent: a resend (or a second tab) lands on the same game, quiz or seat. |
| Stolen admin account | Sensitive admin actions are emailed (see [Email alerts](#email-alerts)); "sign out everywhere" and "reset password" revoke every token issued before them. |

## Cost

Everything is pay-per-use and nothing runs while idle. Lambda, API Gateway and DynamoDB on-demand all fall within or near the AWS free tier for a hobby project. A 10-question game with 5 players costs a fraction of a cent.

The one thing that always runs is the uptime monitor. Each month that's about 43,000 small Lambda runs, which fit in the free tier, plus as many HTTP API calls and WebSocket handshakes, which cost a few cents. CloudWatch charges about $0.10 a month for each alarm beyond the first 10 (there are 14) and $0.30 for each custom metric beyond the first 10. SNS email is free up to 1,000 emails a month.

## Project layout

```
public/                     frontend (vanilla JS, no build step), deployed to S3
  index.html                landing page    play.html       game page
  how-it-works.html         interactive tour of how Quibble is built on AWS (js/how.js, css/how.css)
  js/app.js                 player app      js/admin.js     admin console (pages in js/admin/)
  js/realtime.js            WebSocket client with acks, resends + auto-reconnect
  js/net.js                 HTTP client with retries and backoff
aws/
  template.yaml             all infrastructure (AWS SAM / CloudFormation)
  backend/src/handlers/     the Lambda entry points (HTTP, three WebSocket routes, game timer, monitor)
  backend/src/lib/          game engine, DynamoDB access, auth, push, metrics
  scripts/                  deploy, publish frontend, seed, preflight, Lambda quota
  local/dev-server.mjs      local stand-in for API Gateway + Lambda (with failure emulation)
  tests/                    unit, end-to-end and load tests
```

## Known trade-offs

- Leaderboards are recomputed with one scan of the Results table after each game and stored as a single item that page loads read. That's fine for thousands of games. At larger scale, keep running totals with DynamoDB Streams.
- The JWT secret is a Lambda environment variable. For production, move it to Secrets Manager or SSM Parameter Store (it also names the published flag files, so rotating it needs a redeploy, which republishes them).
- Logging out forgets the token in the browser; the token itself stays valid until it expires (7 days) unless an admin uses "sign out everywhere". Players have no self-service "sign out everywhere".
- The site is served from S3, which can't send HTTP security headers: the CSP is a `<meta>` tag, so `frame-ancestors` (clickjacking) can't be set. CloudFront in front of the bucket would add real headers.
- Typed answers ("type it" questions) from other players are shown on the reveal screen without a profanity filter.
- The site is served from S3's HTTPS endpoint, which has no index page and an `amazonaws.com` address. Put CloudFront in front of the bucket for a custom domain and `/` URLs.

## License

MIT
