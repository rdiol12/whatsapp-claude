import config from './config.js';

/** Get current time as a Date object in the configured timezone. */
export function now() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
}

/** Format a timestamp as YYYY-MM-DD in the configured timezone. */
export function formatDate(ts, opts = {}) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: config.timezone, ...opts });
}

/** Format a timestamp as HH:MM in the configured timezone. */
export function formatTime(ts, opts = {}) {
  return new Date(ts).toLocaleTimeString('en-US', {
    timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hour12: false, ...opts,
  });
}

/** Format a timestamp as a full date+time string in the configured timezone. */
export function formatDateTime(ts, opts = {}) {
  return new Date(ts).toLocaleString('en-US', { timeZone: config.timezone, ...opts });
}

/** Return the configured timezone string (e.g. 'Asia/Jerusalem'). */
export function TZ() {
  return config.timezone;
}
