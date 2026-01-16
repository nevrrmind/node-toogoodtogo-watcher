import _ from "lodash";
import { combineLatest, from, of, timer } from "rxjs";
import { catchError, expand, filter, map, mergeMap, retry } from "rxjs/operators";
import { config } from "./config.js";
import {
  login,
  listFavoriteBusinesses,
  updateAppVersion,
} from "./toogoodtogo-api.js";

const MINIMAL_POLLING_INTERVAL = 15000;
const MINIMAL_AUTHENTICATION_INTERVAL = 3600000;
const APP_VERSION_REFRESH_INTERVAL = 86400000;

const DEFAULT_POLLING_MIN_MS = 40000;
const DEFAULT_POLLING_MAX_MS = 120000;

export function pollFavoriteBusinesses$(enabled$) {
  const pollTick$ = timer(0).pipe(expand(() => timer(getRandomPollingIntervalInMs())));

  return combineLatest([
    enabled$,
    pollTick$,
    authenticateByInterval$(),
    updateAppVersionByInterval$(),
  ]).pipe(
    filter(([enabled]) => enabled),
    mergeMap(() =>
      from(listFavoriteBusinesses()).pipe(
        retry(2),
        catchError(logError),
        filter((response) => !!_.get(response, "items")),
        map((response) => response.items),
      ),
    ),
  );
}

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

function logError(error) {
  if (error.options) {
    console.error(
      `Error during request: ${error.options.method} ${error.options.url.toString()} ${JSON.stringify(
        error.options.json,
        null,
        4,
      )} ${error.stack}`,
    );
  } else if (error.stack) {
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

  // Kompatibilitäts-Fallback: bisheriges Einzel-Intervall
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
