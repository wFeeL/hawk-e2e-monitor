# Architecture

hawk-e2e-monitor is a standalone service that checks Hawk from the outside, the
way a user meets it. It sends test error events through the public integration
interface, then confirms through the public API and notification channels that
each event went through the whole pipeline, and records how long every stage
took.

The service talks to Hawk only through its public interfaces: the collector,
the GraphQL API and outgoing notifications. It needs no access to Hawk
databases or queues, so the same build can watch a local instance or
production.

## Modules

| Module | Responsibility | Boundary | Introduced by |
|---|---|---|---|
| `config` | Reads environment variables, validates them, produces a typed config and a log summary with secrets hidden | The only place that reads `process.env` | service skeleton |
| `log` | Structured JSON logs, to stdout by default | Never throws, so a logging failure cannot break a check. The `check` command sends logs to stderr, so stdout carries only the result | service skeleton |
| `http` | Internal port: `/healthz`, `/readyz`, later metrics and manual runs | Never exposed to the internet; answers about the monitor itself, not about Hawk | service skeleton |
| `receiver` | Public port that accepts Hawk webhook and loop notifications and the monitor's own probe | Serves only `/hooks/webhook`, `/hooks/loop` and `/hooks/probe` under the secret, on a separate port from `http`; never logs paths or bodies | check-notification |
| `notifications` | Public address of the receiver and the notification rule of the instance | Provisioning is idempotent and changes only what differs; only the rule with the instance's exact `including` is touched | check-notification |
| `clients` | Collector, GraphQL API and notification clients with timeouts | Every external call goes through a client, and every external error becomes a named error class | send-and-receive-event |
| `net` | HTTP requests and WebSocket exchanges with deadlines, classification of network failures, retries | Retries only when the request certainly did not leave the monitor | send-and-receive-event |
| `errors` | Error classes with the culprit (Hawk, monitor, configuration, network) and a human-readable text; masking of secrets | Every result and log line passes through the redactor | send-and-receive-event |
| `hawk` | Decoding of the integration token, collector addresses derived from it | Pure functions, no I/O | send-and-receive-event |
| `time` | Monotonic and wall clocks behind one interface | Passed as a parameter, so deadline tests run on a fake clock | send-and-receive-event |
| `commands` | Command-line commands, `check` runs one scenario and prints its result | Exit code 0 for ok, 1 for a failed run or a configuration error, 2 for wrong arguments | send-and-receive-event |
| `engine` | Runs scenario stages with deadlines and condition polling | Knows stages and deadlines, not Hawk specifics | send-and-receive-event |
| `scenarios` | The checks themselves: send and receive an event, notification, endpoint probe, Telegram delivery | Built from engine stages and clients | send-and-receive-event |
| `cleanup` | Removes test events; picking up events that arrive after their run comes with continuous monitoring | Touches only events created by this monitor instance; in the first version it is the last stage of the scenario | send-and-receive-event |
| `storage` | Run and stage history in SQLite | Survives container recreation through a named volume | continuous-monitoring |
| `alerting` | Telegram alerts on state changes: ok, failing, recovered | One message per transition, no repeats | continuous-monitoring |
| `metrics` | Prometheus metrics | Labels have a bounded set of values; run ids and error texts never become labels | observability |
| `heartbeat` | External ping after each run | Lets an outside service notice that the monitor itself stopped | observability |

The public webhook is served by a separate `receiver` server on its own port.
The internal server never takes routes from it, and its error log records the
request path without the query string.

## How a send-and-receive run works

A run gets a sequence number. Odd numbers send over HTTP with catcher type
`errors/nodejs`, even numbers over WebSocket with `errors/javascript`, the way
the Node and browser SDKs do. Every N-th run of a transport also sends the same
event a second time.

| Stage | What it checks |
|---|---|
| `collector_availability` | `/health` of the collector answers with both dependencies up; an unknown token sent over WebSocket is rejected with code 400 |
| `api_availability` | the monitor signs in, the project token in Hawk matches the configured one, the workspace is not blocked and has quota left |
| `collector_accept` | the collector confirms the event with code 200 |
| `event_visible` | the event shows up in the project's event list, its card has the sent title, context, catcher type and a count of 1 |
| `event_repeated` | in repeat runs, the second event is grouped with the first and the count becomes 2 |
| `cleanup` | the event is removed after a check that it belongs to this run and instance. Before removal the monitor waits a few seconds and reads the card again: a count that grew means Hawk stored a late duplicate. An event that never showed up during the run is searched for once more, even when the collector confirmed it |

Each stage has its own time limit, and the whole run has one more. Cleanup has
a separate limit on top of the run limit, so a run that ran out of time still
removes its event. When the collector did not confirm an event (timeout, 5xx,
closed socket), the run keeps looking for it. If the API answered and the event
never appeared, the run is blamed on the collector, and the text names both
facts. The result is one JSON object with every stage, its duration and, on
failure, the stage, error class, culprit and text.

## How a check-notification run works

The run sends one event, like send-and-receive-event, and also waits for the
notifications Hawk sends about it. The monitor keeps one notification rule per
instance in the test project: it matches titles that start with
`[e2e:<instance>]`, excludes send-and-receive-event titles, and has two
channels pointing at the monitor's receiver, webhook and loop. The receiver
paths carry a secret, because Hawk cannot add custom headers to notifications.

| Stage | What it checks |
|---|---|
| `collector_availability`, `api_availability` | as in send-and-receive-event |
| `notification_setup` | the public address of the receiver is known (a fixed `PUBLIC_BASE_URL` or the hostname of a cloudflared quick tunnel), a request through it reaches this process, and the rule has the current address. A changed rule starts a warmup of 65 s |
| `collector_accept` | the run registers its wait at the receiver before the event is sent, so a fast notification is not lost |
| `event_visible` and `notification_formed` | run in parallel. The notification is bound to the run by the run id in its raw body, then its headers, project id, title and event id are compared with what the API shows. One channel is enough; the second is waited for a short time and its absence is a warning |
| `cleanup` | as in send-and-receive-event; afterwards the receiver counts notifications per channel, more than one gives `duplicate_notification` |

When no notification arrives, the run probes the receiver once more through
the public address. A failed probe means the tunnel or the receiver is down
(`receiver_unreachable`, blamed on the monitor); a working probe means Hawk did
not send (`notification_timeout`). During the warmup after a rule change the
notification stage is skipped, because Hawk's notifier may still hold the old
rules.

## Health and readiness

`/healthz` answers whether the monitor process is alive. `/readyz` answers
whether the monitor finished its own startup work. Neither depends on Hawk
being available: a broken Hawk is a check result, not a sick monitor. The
container healthcheck uses `/healthz` only.

## Fatal error policy

An unhandled promise rejection or an uncaught exception ends the process with
exit code 1. The container orchestrator restarts it. A run interrupted this
way is recorded as aborted and counts as a failed check, so a crash loop shows
up as an alert instead of hiding behind a green healthcheck.

Errors inside a single HTTP request are handled locally: the request gets a
500 response, the error is logged and the process keeps running.

## Decisions

| Decision | Rejected alternative | Price |
|---|---|---|
| npm with a lockfile | yarn, used by the Hawk team | differs from the team habit |
| ESM, `module: nodenext`, compiled with `tsc` into `dist/` | CommonJS; running TypeScript directly through Node type stripping | two tsconfig files and `.js` extensions in imports |
| TypeScript 6.0 | TypeScript 7.0 (native compiler) | typescript-eslint supports TypeScript below 6.1, so 7.0 would break typed linting |
| ESLint 9 with `eslint-config-codex` | ESLint 10 | `eslint-config-codex` 2.0.3 requires ESLint 9, which is out of upstream support |
| Configuration from environment variables only; a `.env` file through `node --env-file-if-exists` in development and `env_file` in compose | a YAML file; dotenv; reading `.env` from code | nested and list settings are awkward in env variables. The code never reads files, so behaviour does not depend on what lies in the working directory |
| zod validation, visibility of each field declared in the schema, hidden by default | manual checks; a separate list of secrets | one runtime dependency; a new field must be marked public to appear in the startup log |
| `HAWK_API_URL` and `INSTANCE_ID` are required | defaults pointing to production and a shared instance id | a little more setup, but a forgotten variable cannot send requests to production or mix two monitors in one project |
| Plain `node:http` for the internal and public ports | fastify, express | routing, body parsing and limits are written by hand; no framework dependency on the public port |
| Own JSON logger | pino | no transports or pretty printing |
| Fatal errors end the process | log and continue | an interrupted run is lost; the process never keeps running in an unknown state |
| Internal port 8090 bound to `127.0.0.1`, `0.0.0.0` inside the container | port 9100; always `0.0.0.0` | 9100 belongs to node_exporter, which often runs next to Prometheus; `0.0.0.0` on a host would expose internal endpoints to the local network |
| The Hawk project is prepared by a human and passed through configuration | the service creates the project itself | one manual setup step before the first run |
| No CI pipeline for lint and tests | GitHub Actions on push | checks run locally before each commit. The monitor itself does not depend on any CI system |
| Test events go out as raw HTTP POST and raw WebSocket messages | the `@hawk.so/nodejs` and `@hawk.so/javascript` SDKs | the SDKs do not return the collector's answer; the price is that the SDK code itself is not checked |
| Transport alternates by run number, repeats happen every N-th run of each transport | HTTP only; both transports in every run | HTTP only misses the browser path, both in every run doubles the use of the collector rate limit window. Each path is checked every second interval |
| Catcher types `errors/nodejs` and `errors/javascript` | `errors/default` | matches what the real SDKs send. Which queue and worker handled the event is not visible from outside; a broken worker shows up as a missing event on its transport |
| The invalid token probe goes over WebSocket with a constant token | over HTTP; no probe | an HTTP probe would add noise to the team's own Hawk. A failed WebSocket handshake is harder to diagnose, the HTTP `/health` of the same host makes up for it |
| Run ids are 16 Latin letters | time in base36 plus randomness; UUID | digits may be masked by the grouper's card number filter and change `context.runId`. The run id carries no time, the result does |
| The project token is compared decoded (`integrationId` and `secret` without dashes) | as a string | the collector compares it the same way, a string comparison fails on a re-encoded token. Costs a token decoder in the monitor |
| Quota and the blocked flag are checked before sending | send and watch for 402 | no event is spent. The counter is refreshed by Hawk on a schedule, so the check is approximate |
| Removal by `originalEventId` after checking that the event is ours | by the event id from the list; without the check | after a repeat the list returns the id of the repeat. Costs one card request, made by the visibility stage anyway |
| A POST is retried only before it was sent | retry on network errors and 5xx | a retry after sending duplicates the event and gives a false `duplicate_event`. A one-off failure after sending gives `uncertain` instead of a successful resend |
| Cleanup waits `LATE_DUPLICATE_WAIT_MS` (5 s) and rereads the event card before removing it | one look at the card when the event is first found | a second copy delivered a few seconds later would be removed unnoticed. Every run with a found event takes 5 s longer |
| Cleanup searches for the event whenever it was sent, also after a confirmed accept | search only when the accept is uncertain | an event that arrives after the visibility deadline would stay in the project. Costs one API request in failed runs |
| A failed cleanup makes the run fail, but the run keeps the class of the first failure | a warning only | left-over test events break isolation from other users of the project. Costs an alert caused by removal while the event itself passed |
| The engine supports a group of parallel stages | sequential stages only | the notification check needs to wait for the event and the webhook together. The engine is more complex already in the first version |
| The fake Hawk used in tests tells requests apart by `operationName` and validates query texts against a schema fixture | a full GraphQL server; no schema check | a typo in a field would otherwise surface only on a live Hawk. The schema fixture must follow API changes |
| Durations are measured by the monitor with a monotonic clock | the event timestamp set by Hawk | the collector sets the time itself. The latency includes the network to the collector |
| A non-`hawk.so` API with an empty `HAWK_COLLECTOR_URL` is a configuration error | a startup warning | the token would route test events of a local stand to production. Changes the behaviour of the service skeleton |
| `HAWK_PROJECT_ID` must be 24 hex characters | any non-empty string | an invalid id makes the API answer `INTERNAL_SERVER_ERROR`, a false Hawk failure |
| check-notification reuses the event of the send-and-receive path | a separate event for the notification | one event per run instead of two. A notification failure and a visibility failure can show up in the same run; the stages tell them apart |
| Either of the two channels proves that Hawk formed the notification | webhook only; wait for both until the timeout | the webhook sender on hawk.so is not confirmed. A broken single sender shows up only as a warning |
| The notification is bound to its run by the run id in the raw body | by the parsed title | a malformed body would otherwise look like a missing notification |
| The receiver address comes from `PUBLIC_BASE_URL` or from the `/quicktunnel` route of cloudflared metrics; the monitor does not start cloudflared | starting cloudflared as a child process | a quick tunnel gets a new hostname on every restart, so the rule is checked and updated in every run |
| The secret is part of the receiver paths | a secret header | Hawk cannot set headers. Every member of the workspace can read the rule and its address |
| Warmup by the time of the last rule change that affects matching, kept by the process that made the change | wait 60 s in every run | runs of that process within 65 s after the change skip the notification stage; `provision` waits the same time before it exits. A run of another process right after `provision --no-wait` can fail with `notification_timeout` |
| The rule excludes send-and-receive-event titles | a separate title prefix per scenario | every send-and-receive event would otherwise produce two notifications |
