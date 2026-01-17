import _ from "lodash";
import {
  EMPTY,
  from,
  merge,
  of,
  timer,
  defer,
} from "rxjs";
import {
  catchError,
  expand,
  filter,
  map,
  mergeMap,
  retry,
  switchMap,
  ignoreElements,
} from "rxjs/operators";

import { config } from "./config.js";
import {
  login,
  listFavoriteBusinesses,
  updateAppVersion,
} from "./toogoodtogo-api.js";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const MINIMAL_POLLING_INTERVAL = 15000;
const MINIMAL_AUTHENTICATION_INTERVAL = 3600000;
const APP_VERSION_REFRESH_INTERVAL = 86400000;

const DEFAULT_POLLING_MIN_MS = 40000;
const DEFAULT_POLLING_MAX_MS = 120000;

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function pollFavoriteBusinesses$(enabled$) {
  const sideEffects$ = merge(
    authenticateByInterval$(),
    updateAppVersionByInterval$(),
  ).pipe(ignoreElements());

  const poll$ = enabled$.pipe(
    switchMap((enabled) => (enabled ? pollLoopWith403Backoff$() : EMPTY)),
  );

  return merge(poll$, sideEffects$);
}

/* -------------------------------------------------------------------------- */
/*  Poll loop with random interval + 403 backoff                               */
/* -------------------------------------------------------------------------- */

function pollLoopWith403Backoff$() {
  const threshold = getConfiguredInt("api.backoff403.threshold", 3);
  const windowMs = getConfiguredInt("api.backoff403.windowMs", 300000);
  const cooldownMs = getConfiguredInt("api.backoff403.cooldownMs", 600000);

  return defer(() => {
    const state = {
      error403Timestamps: [],
      cooldownUntil: 0,
    };

    const runOnce$ = () => {
      console.log("[POLL] 🔁 tick");

      return from(listFavoriteBusinesses()).pipe(
        retry(2),
        map((response) => ({ kind: "success", response })),
        catchError((err) => of({ kind: "error", err })),
      );
    };

    return runOnce$().pipe(
      expand((event) => {
        const now = Date.now();

        /* ---------- error handling ---------- */
        if (event.kind === "error" && isHttp403(event.err)) {
          state.error403Timestamps.push(now);

          state.error403Timestamps = state.error403Timestamps.filter(
            (t) => now - t <= windowMs,
          );

          const count = state.error403Timestamps.length;
          console.warn(
            `[POLL] ⚠️ got HTTP 403 (${count}/${threshold} within ${Math.round(windowMs / 1000)}s)`,
          );

          if (state.error403Timestamps.length >= threshold) {
            state.cooldownUntil = Math.max(state.cooldownUntil, now + cooldownMs);
            state.error403Timestamps = [];

            console.warn(
              `[POLL] ⚠️ 403 backoff triggered (${threshold}x within ${Math.round(
                windowMs / 1000,
              )}s) – cooldown 🧊 ${Math.round(cooldownMs / 1000)}s`,
            );
          }
        } else if (event.kind === "error") {
          logError(event.err);
        }

        /* ---------- delay calculation ---------- */
        const randomDelay = getRandomPollingIntervalInMs();
        const cooldownDelay = Math.max(0, state.cooldownUntil - now);
        const nextDelay = Math.max(randomDelay, cooldownDelay);

        if (cooldownDelay > 0) {
          console.warn(
            `[POLL] 🧊 cooldown active – next poll in ${Math.round(
              nextDelay / 1000,
            )}s`,
          );
        } else {
          console.log(
            `[POLL] ⏱️ next poll in ${Math.round(
              nextDelay / 1000,
            )}s (random=${Math.round(randomDelay / 1000)}s)`,
          );
        }

        return timer(nextDelay).pipe(mergeMap(() => runOnce$()));
      }),

      filter((event) => event.kind === "success"),
      map((event) => event.response),
      filter((response) => !!_.get(response, "items")),
      map((response) => response.items),
    );
  });
}

/* -------------------------------------------------------------------------- */
/*  Side effects                                                               */
/* -------------------------------------------------------------------------- */

function authenticateByInterval$() {
  const authenticationIntervalInMs = getInterval(
    "api.authenticationIntervalInMS",
    MINIMAL_AUTHENTICATION_INTERVAL,
  );

  return timer(0, authenticationIntervalInMs).pipe(
    mergeMap(() => from(login()).pipe(retry(2), catchError(logError))),
  );
}

function updateAppVersionByInterval$() {
  return timer(0, APP_VERSION_REFRESH_INTERVAL).pipe(mergeMap(updateAppVersion));
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isHttp403(error) {
  const code =
    error?.response?.statusCode ??
    error?.response?.status ??
    error?.statusCode ??
    error?.status;

  return code === 403;
}

function logError(error) {
  if (error?.options) {
    console.error(
      `Error during request: ${error.options.method} ${error.options.url?.toString?.()} ${JSON.stringify(
        error.options.json,
        null,
        4,
      )} ${error.stack}`,
    );
  } else if (error?.stack) {
    console.error(error.stack);
  } else {
    console.error(error);
  }

  return of(null);
}

function getInterval(configPath, minimumIntervalInMs) {
  const configuredIntervalInMs = config.get(configPath);
  return _.isFinite(configuredIntervalInMs)
    ? Math.max(configuredIntervalInMs, minimumIntervalInMs)
    : minimumIntervalInMs;
}

function getConfiguredInt(configPath, fallback) {
  const v = config.get(configPath);
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function getConfiguredNumber(configPath) {
  const v = config.get(configPath);
  return _.isFinite(v) ? Number(v) : null;
}

function randomIntInclusive(min, max) {
  const minInt = Math.ceil(min);
  const maxInt = Math.floor(max);
  return Math.floor(Math.random() * (maxInt - minInt + 1)) + minInt;
}

function getRandomPollingIntervalInMs() {
  const cfgMin = getConfiguredNumber("api.pollingIntervalMinInMs");
  const cfgMax = getConfiguredNumber("api.pollingIntervalMaxInMs");
  const legacyFixed = getConfiguredNumber("api.pollingIntervalInMs");

  let minMs;
  let maxMs;

  if (cfgMin === null && cfgMax === null) {
    if (legacyFixed !== null) {
      minMs = legacyFixed;
      maxMs = legacyFixed;
    } else {
      minMs = DEFAULT_POLLING_MIN_MS;
      maxMs = DEFAULT_POLLING_MAX_MS;
    }
  } else {
    minMs = cfgMin !== null ? cfgMin : DEFAULT_POLLING_MIN_MS;
    maxMs = cfgMax !== null ? cfgMax : DEFAULT_POLLING_MAX_MS;
  }

  minMs = Math.max(minMs, MINIMAL_POLLING_INTERVAL);
  maxMs = Math.max(maxMs, minMs);

  return randomIntInclusive(minMs, maxMs);
}
