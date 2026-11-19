import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GOAL, newSession, measure, settle, togglePause, finishEarly, validateData, streak } from "./timer.js";

const start = (goal = DEFAULT_GOAL, now = 1000, id = "test", day = "2026-11-19") =>
  newSession(goal, now, id, day);
const backup = (sessions = [], current = null) =>
  ({ version: 1, goalMs: DEFAULT_GOAL, sessions, current });

test("five minutes excludes every break and retains individual pause lengths", () => {
  let session = start();
  session = togglePause(session, 61_000);
  session = togglePause(session, 81_000);
  session = togglePause(session, 201_000);
  assert.deepEqual(measure(session, 231_000), {
    activeMs: 180_000, restMs: 50_000, longestHoldMs: 120_000,
    pauses: [20_000, 30_000], remainingMs: 120_000,
  });
  session = togglePause(session, 231_000);
  session = settle(session, 900_000);
  assert.equal(session.endedAt, 351_000);
  assert.deepEqual(measure(session, session.endedAt), {
    activeMs: 300_000, restMs: 50_000, longestHoldMs: 120_000,
    pauses: [20_000, 30_000], remainingMs: 0,
  });
  assert.doesNotThrow(() => validateData(backup([session])));
});

test("backgrounded or restored sessions stop at the exact goal", () => {
  const session = JSON.parse(JSON.stringify(start()));
  const finished = settle(session, 1_000_000);
  assert.equal(finished.endedAt, 301_000);
  assert.equal(measure(finished, 2_000_000).activeMs, DEFAULT_GOAL);
  assert.equal(togglePause(session, 301_000).endedAt, 301_000);
  assert.deepEqual(settle(finished, 9_000_000), finished);
  assert.equal(session.endedAt, null);
});

test("resting across reload never consumes plank time", () => {
  const paused = JSON.parse(JSON.stringify(togglePause(start(), 11_000)));
  assert.equal(settle(paused, 86_400_000).endedAt, null);
  assert.equal(measure(paused, 86_400_000).activeMs, 10_000);
  assert.deepEqual(measure(paused, 21_123).pauses, [10_123]);
  assert.doesNotThrow(() => validateData(backup([], paused)));
});

test("finishing early during a break closes the final pause and retains partial time", () => {
  const partial = finishEarly(togglePause(start(), 31_000), 36_500);
  assert.equal(partial.endedAt, 36_500);
  assert.equal(measure(partial, 40_000).activeMs, 30_000);
  assert.deepEqual(measure(partial, 40_000).pauses, [5500]);
  assert.doesNotThrow(() => validateData(backup([partial])));
});

test("adjustable goals respect boundaries and rapid taps remain well formed", () => {
  for (const goal of [10_000, 90_000, 3_600_000]) {
    let session = start(goal);
    session = togglePause(session, 1000);
    session = togglePause(session, 1000);
    const finished = settle(session, goal + 1000);
    assert.equal(finished.endedAt, goal + 1000);
    assert.equal(measure(finished, finished.endedAt).activeMs, goal);
    assert.doesNotThrow(() => validateData(backup([finished])));
  }
  for (const goal of [0, 9999, 3_600_001, NaN, 10_000.1]) {
    assert.throws(() => start(goal));
  }
});

test("backup validation rejects malformed, overlapping and duplicate sessions", () => {
  const finished = settle(start(), 301_000);
  const invalid = [
    { ...backup(), version: 2 },
    { ...backup(), goalMs: 0 },
    backup([{ ...finished, localDate: "2026-02-31" }]),
    backup([{ ...finished, endedAt: null }]),
    backup([{ ...finished, endedAt: 900_000 }]),
    backup([{ ...finished, segments: [{ kind: "rest", start: 1000, end: 301_000 }] }]),
    backup([{ ...finished, segments: [{ kind: "hold", start: 0, end: 301_000 }] }]),
    backup([finished, finished]),
    backup([], finished),
    backup([{ ...finished, segments: [{ kind: "hold", start: 1000, end: 302_000 }], endedAt: 302_000 }]),
    backup([], { ...start(), segments: [null] }),
  ];
  for (const value of invalid) assert.throws(() => validateData(value));
  assert.doesNotThrow(() => validateData(JSON.parse(JSON.stringify(backup([finished])))));
});

test("streak counts calendar days once, allows today to be pending and excludes partials", () => {
  const complete = (day, id = day) => settle(start(10_000, 1000, id, day), 11_000);
  const sessions = [complete("2026-11-17"), complete("2026-11-18"), complete("2026-11-18", "extra")];
  assert.equal(streak(sessions, "2026-11-19"), 2);
  assert.equal(streak(sessions, "2026-11-20"), 0);
  sessions.push(complete("2026-11-19"));
  assert.equal(streak(sessions, "2026-11-19"), 3);
  sessions.push(finishEarly(start(10_000, 1000, "partial", "2026-11-20"), 2000));
  assert.equal(streak(sessions, "2026-11-21"), 0);
  assert.equal(streak([complete("2026-10-31"), complete("2026-11-01")], "2026-11-02"), 2);
});
