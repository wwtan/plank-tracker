export const DEFAULT_GOAL = 300_000;
export const MAX_GOAL = 3_600_000;

export function newSession(goalMs, now, id, localDate) {
  if (!Number.isInteger(goalMs) || goalMs < 10_000 || goalMs > MAX_GOAL) {
    throw new Error("Choose a goal between 10 seconds and 60 minutes.");
  }
  return {
    id, localDate, goalMs, startedAt: now, endedAt: null,
    segments: [{ kind: "hold", start: now, end: null }],
  };
}

export function measure(session, now) {
  let activeMs = 0;
  let restMs = 0;
  let longestHoldMs = 0;
  const pauses = [];
  for (const segment of session.segments) {
    const duration = Math.max(0, (segment.end ?? now) - segment.start);
    if (segment.kind === "hold") {
      const counted = Math.min(duration, session.goalMs - activeMs);
      activeMs += counted;
      longestHoldMs = Math.max(longestHoldMs, counted);
    } else {
      restMs += duration;
      pauses.push(duration);
    }
  }
  return { activeMs, restMs, longestHoldMs, pauses, remainingMs: session.goalMs - activeMs };
}

// Close at the actual goal time, even if a backgrounded tab wakes up much later.
export function settle(session, now) {
  if (session.endedAt !== null || measure(session, now).remainingMs > 0) return session;
  const segments = session.segments.map(segment => ({ ...segment }));
  const last = segments.at(-1);
  const before = measure({ ...session, segments: segments.slice(0, -1) }, now).activeMs;
  last.end = last.start + session.goalMs - before;
  return { ...session, segments, endedAt: last.end };
}

export function togglePause(session, now) {
  const current = settle(session, now);
  if (current.endedAt !== null) return current;
  const segments = current.segments.map(segment => ({ ...segment }));
  const last = segments.at(-1);
  const time = Math.max(now, last.start);
  last.end = time;
  segments.push({ kind: last.kind === "hold" ? "rest" : "hold", start: time, end: null });
  return { ...current, segments };
}

export function finishEarly(session, now) {
  const current = settle(session, now);
  if (current.endedAt !== null) return current;
  const segments = current.segments.map(segment => ({ ...segment }));
  const end = Math.max(now, segments.at(-1).start);
  segments.at(-1).end = end;
  return { ...current, segments, endedAt: end };
}

export function localDay(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function streak(sessions, today) {
  const days = new Set(sessions.filter(s => measure(s, s.endedAt).remainingMs === 0).map(s => s.localDate));
  // Calendar arithmetic, rather than 24-hour subtraction, handles daylight-saving changes.
  const cursor = new Date(`${today}T12:00:00`);
  if (!days.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (days.has(localDay(cursor))) {
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

function validSession(session, finished) {
  const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
  if (!session || typeof session.id !== "string" || !session.id ||
      typeof session.localDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(session.localDate) ||
      !Number.isFinite(Date.parse(`${session.localDate}T12:00:00Z`)) ||
      new Date(`${session.localDate}T12:00:00Z`).toISOString().slice(0, 10) !== session.localDate ||
      !Number.isInteger(session.goalMs) || session.goalMs < 10_000 || session.goalMs > MAX_GOAL ||
      !time(session.startedAt) || !Array.isArray(session.segments) || !session.segments.length ||
      (finished ? !time(session.endedAt) : session.endedAt !== null)) return false;
  let previousEnd = session.startedAt;
  let activeMs = 0;
  for (let i = 0; i < session.segments.length; i++) {
    const segment = session.segments[i];
    if (!segment || segment.kind !== (i % 2 === 0 ? "hold" : "rest") ||
        !time(segment.start) || segment.start !== previousEnd) return false;
    const open = !finished && i === session.segments.length - 1;
    if (open ? segment.end !== null : !time(segment.end) || segment.end < segment.start) return false;
    if (segment.kind === "hold" && segment.end !== null) activeMs += segment.end - segment.start;
    if (activeMs > session.goalMs) return false;
    previousEnd = segment.end;
  }
  return !finished || previousEnd === session.endedAt;
}

export function validateData(data) {
  if (!data || data.version !== 1 || !Number.isInteger(data.goalMs) ||
      data.goalMs < 10_000 || data.goalMs > MAX_GOAL || !Array.isArray(data.sessions) ||
      !data.sessions.every(session => validSession(session, true)) ||
      (data.current !== null && !validSession(data.current, false))) {
    throw new Error("This is not a valid Plank Tracker backup. Your existing data has not been changed.");
  }
  const ids = data.sessions.map(session => session.id);
  if (data.current) ids.push(data.current.id);
  if (new Set(ids).size !== ids.length) throw new Error("This backup contains duplicate sessions.");
  return data;
}
