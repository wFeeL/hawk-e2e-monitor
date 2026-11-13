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
| `log` | Structured JSON logs to stdout | Never throws, so a logging failure cannot break a check | service skeleton |
| `http` | Internal port: `/healthz`, `/readyz`, later metrics and manual runs | Never exposed to the internet; answers about the monitor itself, not about Hawk | service skeleton |
| `receiver` | Public port that accepts Hawk webhooks | Serves the webhook path only, on a separate port from `http` | check-notification |
| `provisioning` | Brings the notification rule of the test project to the expected state | Idempotent, changes only what differs | check-notification |
| `clients` | Collector, GraphQL API and notification clients with timeouts | Every external call goes through a client, and every external error becomes a named error class | send-and-receive-event |
| `engine` | Runs scenario stages with deadlines and condition polling | Knows stages and deadlines, not Hawk specifics | send-and-receive-event |
| `scenarios` | The checks themselves: send and receive an event, notification, endpoint probe, Telegram delivery | Built from engine stages and clients | send-and-receive-event |
| `cleanup` | Removes test events, picks up late ones | Touches only events created by this monitor instance | send-and-receive-event |
| `storage` | Run and stage history in SQLite | Survives container recreation through a named volume | continuous-monitoring |
| `alerting` | Telegram alerts on state changes: ok, failing, recovered | One message per transition, no repeats | continuous-monitoring |
| `metrics` | Prometheus metrics | Labels have a bounded set of values; run ids and error texts never become labels | observability |
| `heartbeat` | External ping after each run | Lets an outside service notice that the monitor itself stopped | observability |

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
