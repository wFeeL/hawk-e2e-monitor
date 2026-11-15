/** Key in `kv` that holds the time the notification rule last changed matching. */
export const MATCH_CHANGED_KEY = 'rule_match_changed_at';

/** Key in `kv` that holds the time the Telegram rule last changed matching. */
export const TELEGRAM_MATCH_CHANGED_KEY = 'rule_match_changed_at:telegram';

/** Key in `kv` that holds the ids of the projects `new-project` created and has not removed yet, as a JSON list. */
export const NEW_PROJECT_KEY = 'new-project:created';

/** Key in `kv` that holds the runs of `new-project` that may have created a project whose id is unknown, as a JSON list of `{ runId, at }`. */
export const NEW_PROJECT_PENDING_KEY = 'new-project:pending';
