/**
 * Minimal event broadcaster for WebSocket push.
 * bot-ipc.js registers the broadcast function at startup.
 * Other modules call emit() to push events to dashboard clients.
 */

let broadcastFn = null;

/** Called by bot-ipc.js to register the WS broadcast function */
export function registerBroadcast(fn) {
  broadcastFn = fn;
}

/** Emit an event to all connected dashboard WS clients */
export function emit(event, data) {
  if (broadcastFn) broadcastFn(event, data);
}
