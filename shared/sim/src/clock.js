/**
 * The server's shot deadline expressed on this device's clock.
 *
 * A phone's clock can be seconds off the server's. Comparing the server's
 * absolute deadline with the phone's Date.now() would show time left after
 * the server had already expired the turn (or the reverse). The server sends
 * its own time with the deadline, so only the time remaining is carried over.
 * The one error left is the response's transit time, which makes the local
 * deadline slightly late; SHOT_CLOCK_GRACE_MS covers that on the server.
 *
 * @param {string|number|Date|null} shotDeadline  server deadline
 * @param {number|undefined} serverNow  server time (ms) when the response was built
 * @param {number} localNow  this device's time (ms) when the response arrived
 * @returns {number|null}  local ms timestamp, or null when there is no deadline
 */
export function localDeadline(shotDeadline, serverNow, localNow = Date.now()) {
  if (shotDeadline === null || shotDeadline === undefined) return null;
  const deadline = new Date(shotDeadline).getTime();
  if (!Number.isFinite(deadline)) return null;
  // An older server that does not send its time: fall back to the absolute deadline.
  if (!Number.isFinite(serverNow)) return deadline;
  return localNow + (deadline - serverNow);
}
