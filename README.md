# Quibble

**Quibble is a real-time multiplayer quiz game built entirely on serverless AWS.**
One person hosts a game and gets a 6-character code, friends join from their phones, and everyone races the same countdown. Faster correct answers score more points.

`API Gateway (WebSocket + HTTP)` · `AWS Lambda` · `Amazon DynamoDB` · `Amazon S3` · `Amazon CloudWatch` · `AWS IAM`

---

## Features

- **Live multiplayer** over WebSockets: lobby, synchronized countdown, per-question results, final podium
- **The server decides everything.** It holds the answers, runs the clock, measures answer speed and scores every answer. The browser only ever sends "I picked option 2"
- **Speed scoring:** 1000 points for an instant correct answer, sliding down to 500 at the buzzer
- **Reconnect-safe:** refresh or drop your connection mid-game and you land back in the same question
- **Leaderboards** (all-time and this week) and a personal match history
- **Admin panel:** question editor, one-click trivia import from Open Trivia DB, promote or ban users (a ban kicks them out of live games instantly), usage stats
- **Security:** bcrypt passwords, signed JWTs, input validation on every REST call *and* every socket message, per-IP login limiting, API Gateway throttling, least-privilege IAM roles
- **Observability:** structured logs, custom game metrics, alarms and a CloudWatch dashboard, all created by the template

## Architecture

```
                 ┌──────────── Amazon S3 static website (the frontend)
 Browser ────────┤
                 ├── HTTPS ──► API Gateway HTTP API ──► Lambda: api ─────────────────┐
                 │                                       (auth, leaderboards, admin)  │
                 └── WSS ────► API Gateway WebSocket API                              ▼
                                 $connect    ──► Lambda: ws-connect           Amazon DynamoDB
                                 $default    ──► Lambda: ws-message  ──────►  Users · Questions
                                 $disconnect ──► Lambda: ws-disconnect        Games · Connections
                                                    │  ▲                      Results · RateLimits
                     async invoke at deadline ──────┘  │ PostToConnection
                                 Lambda: game-timer ───┘ (pushes events to every player)

 Amazon CloudWatch  log groups (14-day retention) · alarms · custom metrics · dashboard
 AWS IAM            one role per Lambda, scoped to exactly the tables and APIs it uses
```

| Service | What it does in Quibble |
|---|---|
| **API Gateway WebSocket API** | Persistent connection for gameplay: `$connect` authenticates, `$default` handles game actions, `$disconnect` marks players offline |
| **API Gateway HTTP API** | REST endpoints for login, leaderboards, history and the admin panel |
| **AWS Lambda** | Five Node.js 22 functions on arm64: `api`, `ws-connect`, `ws-message`, `ws-disconnect`, `game-timer` |
| **Amazon DynamoDB** | Six on-demand tables. TTL cleans up old games, sockets and rate-limit counters |
| **Amazon S3** | Hosts the static frontend as a public website |
| **Amazon CloudWatch** | Logs, 4 alarms, a dashboard and custom metrics in the `Quibble` namespace |
| **AWS IAM** | Least-privilege execution role per function |

### How a game stays consistent without a server

Lambdas are stateless and short-lived, so a game can't live in memory and can't use `setTimeout`.

- **State:** every live game is a single DynamoDB item. Every change is a *conditional write* on the item's `version` number. If two Lambdas race (say, 30 players answering in the same second), the loser re-reads and retries, so no answer is ever lost.
- **Time:** whoever moves a game into a new phase (question open, results showing) also invokes the `game-timer` Lambda asynchronously with that phase's deadline. The timer waits, then closes the question or opens the next one. If everyone answers early, the question closes at once and the waiting timer notices within about 1.5 s and exits.
- **Push:** Lambdas send events to players' browsers through the API Gateway Management API (`PostToConnection`).

## Run it locally (no AWS account needed)

Requires Node.js 22+ and Docker.

```bash
npm install
docker run -d -p 8000:8000 --name quibble-dynamodb amazon/dynamodb-local
npm run dev            # http://localhost:5050   (admin@example.com / admin12345)
```

`npm run dev` runs the **real Lambda handlers** against DynamoDB Local, with a small Node server standing in for API Gateway. It creates the tables and sample questions on first start. Open two browser windows (one private) to play against yourself.

```bash
npm test               # unit tests (scoring)
npm run test:e2e       # end-to-end games over real WebSockets (needs npm run dev running)
```

## Deploy to AWS

**One-time setup**

1. Install the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).
2. Run `aws configure` with an IAM user or SSO profile that can create the resources, and pick a region.

**Deploy**

```bash
npm run deploy         # sam build + sam deploy + upload the frontend to S3
npm run seed           # first time only: admin account + 68 sample questions
```

The deploy prints the `WebsiteUrl`. Run `npm run deploy` again to ship changes. If only the frontend changed, `npm run publish` is enough.

- The login-token secret is generated on the first deploy and kept in `aws/.jwt-secret`, which is git-ignored.
- Because the site is public, `npm run seed` generates a strong admin password unless `.env` sets one of 10 or more characters.
- **If the deploy fails on the S3 bucket policy**, S3 *Block Public Access* is on for your whole account. Turn off "block public access … through new public bucket policies" in the S3 console, then deploy again.

**Test the live deployment**

```bash
QA_API=<HttpApiUrl> QA_WS=<WebSocketUrl> ADMIN_PASSWORD=<admin password> npm run test:e2e
```

**Tear down:** empty the website bucket, then run `sam delete --stack-name quibble`.

## Monitoring

- **Dashboard** (the `DashboardUrl` output): games created, started, finished and cancelled, answers, WebSocket connections, API latency and errors, Lambda errors and duration, and a live table of recent error logs.
- **Alarms:** `quibble-api-lambda-errors`, `quibble-websocket-lambda-errors`, `quibble-game-timer-errors`, `quibble-http-api-5xx`.
- **Logs Insights:** `fields @timestamp, msg, error.message | filter level = "error" | sort @timestamp desc`

## Cost

Everything is pay-per-use and nothing runs while idle. Lambda, API Gateway and DynamoDB on-demand all fall within or near the AWS free tier for a hobby project. A 10-question game with 5 players costs a fraction of a cent.

## Project layout

```
public/                     frontend (vanilla JS, no build step), deployed to S3
  index.html                landing page    play.html       game page
  js/app.js                 player app      js/admin.js     admin panel
  js/realtime.js            WebSocket client with acks + auto-reconnect
aws/
  template.yaml             all infrastructure (AWS SAM / CloudFormation)
  backend/src/handlers/     the five Lambda entry points
  backend/src/lib/          game engine, DynamoDB access, auth, push, metrics
  scripts/                  deploy, publish frontend, seed
  local/dev-server.mjs      local stand-in for API Gateway + Lambda
  tests/                    unit + end-to-end tests
```

## Known trade-offs

- Leaderboards and admin stats use DynamoDB scans. That's fine for thousands of games. At larger scale, keep running totals with DynamoDB Streams.
- The JWT secret is a Lambda environment variable. For production, move it to Secrets Manager or SSM Parameter Store.
- The S3 website endpoint is HTTP only. Put CloudFront in front of it for HTTPS and a custom domain.

## License

MIT
