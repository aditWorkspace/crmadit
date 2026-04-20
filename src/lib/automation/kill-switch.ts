/**
 * Centralized gates for every auto-send path. Every place that could send an
 * email autonomously checks one of these helpers. Flipping an env var to
 * "false" short-circuits the corresponding path without deploying code.
 *
 * Defaults are "enabled" — you opt OUT by setting the env var to the literal
 * string "false". Missing / unset = enabled. This matches the plan's rollout
 * posture: ship the wiring, let ops flip individual features off during
 * rollout.
 *
 * Precedence:
 *   AUTO_REPLY_ENABLED=false   → disables every auto-send path, feature flags are moot.
 *   FAST_LOOP_ENABLED=false    → disables just the fast-loop queue writes + drains.
 *   INFO_REPLY_ENABLED=false   → demotes info_request to question_only (manual review).
 */

export function autoReplyEnabled(): boolean {
  return process.env.AUTO_REPLY_ENABLED !== 'false';
}

export function fastLoopEnabled(): boolean {
  return autoReplyEnabled() && process.env.FAST_LOOP_ENABLED !== 'false';
}

export function infoReplyEnabled(): boolean {
  return autoReplyEnabled() && process.env.INFO_REPLY_ENABLED !== 'false';
}
