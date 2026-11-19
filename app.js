import { DEFAULT_GOAL, newSession, measure, settle, togglePause, finishEarly, localDay, streak, validateData } from "./timer.js";

const $ = id => document.getElementById(id);
const STORAGE_KEY = "plank-tracker-v1";
let data = { version: 1, goalMs: DEFAULT_GOAL, current: null, sessions: [] };
let storageBlocked = false;
let reloadRequired = false;
let wakeLock = null;
let requestingWakeLock = false;
let installPrompt = null;
let lastDay = localDay(Date.now());

function error(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

function notify(message) {
  $("notice").textContent = message;
  $("notice").hidden = false;
}

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved !== null) data = validateData(JSON.parse(saved));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
} catch (cause) {
  storageBlocked = true;
  error(`Cannot safely load or save your history. Nothing has been overwritten. Export a backup before restoring data, or enable browser storage and reload. ${cause.message}`);
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    storageBlocked = false;
    $("error").hidden = true;
    return true;
  } catch (cause) {
    storageBlocked = true;
    error(`Your latest changes are only in memory. Keep this page open and export a backup now. Browser storage failed: ${cause.message}`);
    return false;
  }
}

function clock(ms, roundUp = false) {
  const seconds = Math.max(0, (roundUp ? Math.ceil : Math.floor)(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function precise(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function dateLabel(session) {
  return new Date(session.startedAt).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

async function releaseScreen() {
  $("device-hint").textContent = "Keep this screen open. Breaks are recorded when you tap Pause.";
  if (wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    try { await lock.release(); }
    catch (cause) { notify(`Screen lock could not be released: ${cause.message}`); }
  }
}

async function keepScreen() {
  if (!data.current || reloadRequired || document.visibilityState !== "visible" || wakeLock || requestingWakeLock) return;
  if (!("wakeLock" in navigator)) {
    $("device-hint").textContent = "Keep your screen awake manually. Tap Pause for every break. The timer continues if you leave this page.";
    return;
  }
  requestingWakeLock = true;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!data.current || document.visibilityState !== "visible") {
      await lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener("release", () => { if (wakeLock === lock) wakeLock = null; });
    $("device-hint").textContent = "Screen kept awake. Tap Pause for every break.";
  } catch (cause) {
    $("device-hint").textContent = `Keep your screen awake manually. The timer still runs in the background. ${cause.message}`;
  } finally {
    requestingWakeLock = false;
  }
}

function closeCompleted(now) {
  if (!data.current || reloadRequired) return false;
  const finished = settle(data.current, now);
  if (finished.endedAt === null) return false;
  data.sessions.push(finished);
  data.current = null;
  const saved = save();
  releaseScreen();
  notify(saved
    ? `Goal complete. ${clock(finished.goalMs)} of plank saved, with ${measure(finished, finished.endedAt).pauses.length} pauses. Well done.`
    : "Goal complete, but browser storage failed. Export a backup before closing this page.");
  renderHistory();
  return true;
}

function appendPauses(container, pauses, resting = false) {
  container.replaceChildren(...pauses.map((duration, index) => {
    const li = document.createElement("li");
    li.textContent = `Pause ${index + 1}: ${precise(duration)}${resting && index === pauses.length - 1 ? " (resting now)" : ""}`;
    return li;
  }));
}

function syncGoalFields() {
  $("goal-minutes").value = Math.floor(data.goalMs / 60_000);
  $("goal-seconds").value = (data.goalMs % 60_000) / 1000;
}

function renderTimer() {
  const session = data.current;
  const stats = session ? measure(session, Date.now()) : null;
  const resting = session?.segments.at(-1).kind === "rest";
  $("session-state").textContent = session ? (resting ? "Rest. Take your time." : "Holding strong") : "Ready when you are";
  $("timer-label").textContent = resting ? "CURRENT BREAK" : "PLANK TIME LEFT";
  $("countdown").textContent = clock(resting ? stats.pauses.at(-1) : stats?.remainingMs ?? data.goalMs, !resting);
  $("countdown").setAttribute("aria-label", resting ? "Current break duration" : "Plank time remaining");
  $("timer-subtitle").textContent = resting ? `${clock(stats.remainingMs, true)} of plank still to go` : session ? `${clock(stats.activeMs)} held so far` : "Make time for you.";
  $("pause-count").textContent = stats?.pauses.length ?? 0;
  $("rest-total").textContent = clock(stats?.restMs ?? 0);
  $("longest-hold").textContent = clock(stats?.longestHoldMs ?? 0);
  $("dial").classList.toggle("resting", resting);
  $("progress-ring").setAttribute("stroke-dashoffset", String(100 - (stats ? stats.activeMs / session.goalMs * 100 : 0)));
  $("primary").textContent = session ? resting ? "Resume plank" : "Pause & rest" : "Start plank";
  $("primary").disabled = reloadRequired || (storageBlocked && !session);
  $("finish").hidden = !session;
  $("finish").disabled = reloadRequired;
  for (const id of ["goal-minutes", "goal-seconds", "save-goal"]) $(id).disabled = !!session || storageBlocked;
  $("live-pauses").hidden = !stats?.pauses.length;
  if (stats) appendPauses($("live-pause-list"), stats.pauses, resting);
}

function svgElement(name, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function drawChart(sessions, title, metric, format, direction) {
  const figure = document.createElement("figure");
  figure.className = "chart";
  const caption = document.createElement("figcaption");
  caption.textContent = title;
  const hint = document.createElement("span");
  hint.textContent = direction;
  caption.append(hint);
  const svg = svgElement("svg", { viewBox: "0 0 600 110", role: "img", "aria-label": `${title}, ${direction}. Each point is one completed session. Exact values are in Your sessions below.` });
  svg.append(svgElement("line", { x1: 8, y1: 96, x2: 592, y2: 96, class: "grid" }));
  const values = sessions.map(session => metric(measure(session, session.endedAt)));
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => ({
    x: values.length === 1 ? 300 : 8 + index / (values.length - 1) * 584,
    y: 96 - value / max * 80,
  }));
  svg.append(svgElement("polyline", { points: points.map(point => `${point.x},${point.y}`).join(" "), class: "line" }));
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const dot = svgElement("circle", { cx: point.x, cy: point.y, r: 4, class: "dot" });
    const tooltip = svgElement("title", {});
    tooltip.textContent = `${dateLabel(sessions[index])}: ${format(values[index])}`;
    dot.append(tooltip);
    svg.append(dot);
  }
  const range = document.createElement("div");
  range.className = "range";
  for (const index of [0, sessions.length - 1]) {
    const label = document.createElement("span");
    label.textContent = `${sessions[index].localDate} / ${format(values[index])}`;
    range.append(label);
  }
  figure.append(caption, svg, range);
  $("charts").append(figure);
}

function renderCharts() {
  const sessions = data.sessions.filter(session =>
    session.goalMs === Number($("chart-goal").value) && measure(session, session.endedAt).remainingMs === 0
  ).sort((a, b) => a.startedAt - b.startedAt).slice(-30);
  $("charts").replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Complete a session to start your progress charts.";
    $("charts").append(empty);
    $("comparison").textContent = "Your first session is your starting point, not a score to beat.";
    return;
  }
  drawChart(sessions, "Pause count", stats => stats.pauses.length, String, "Lower is better");
  drawChart(sessions, "Total rest", stats => stats.restMs, precise, "Lower is better");
  drawChart(sessions, "Longest hold", stats => stats.longestHoldMs, precise, "Higher is better");
  if (sessions.length === 1) {
    $("comparison").textContent = "Starting point saved. Complete another session with this goal to compare.";
    return;
  }
  const first = measure(sessions[0], sessions[0].endedAt);
  const last = measure(sessions.at(-1), sessions.at(-1).endedAt);
  const change = (difference, suffix) => `${difference > 0 ? "+" : ""}${difference}${suffix}`;
  $("comparison").textContent = `Latest vs first shown (${clock(sessions[0].goalMs)} goal): ${change(last.pauses.length - first.pauses.length, " pauses")}, ${change(Number(((last.restMs - first.restMs) / 1000).toFixed(1)), "s rest")}, ${change(Number(((last.longestHoldMs - first.longestHoldMs) / 1000).toFixed(1)), "s longest hold")}.`;
}

function renderHistory() {
  const completed = data.sessions.filter(session => measure(session, session.endedAt).remainingMs === 0);
  $("streak").textContent = streak(data.sessions, localDay(Date.now()));
  $("completed").textContent = completed.length;
  $("best-hold").textContent = clock(Math.max(0, ...completed.map(session => measure(session, session.endedAt).longestHoldMs)));
  const selectedGoal = Number($("chart-goal").value) || data.goalMs;
  const goals = [...new Set([data.goalMs, ...completed.map(session => session.goalMs)])].sort((a, b) => a - b);
  $("chart-goal").replaceChildren(...goals.map(goal => {
    const option = document.createElement("option");
    option.value = goal;
    option.textContent = clock(goal);
    return option;
  }));
  $("chart-goal").value = goals.includes(selectedGoal) ? selectedGoal : data.goalMs;
  renderCharts();
  $("history-count").textContent = `${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"}`;
  if (!data.sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "A little practice, a clearer picture. Your sessions will appear here.";
    $("history").replaceChildren(empty);
    return;
  }
  $("history").replaceChildren(...[...data.sessions].sort((a, b) => b.startedAt - a.startedAt).map(session => {
    const stats = measure(session, session.endedAt);
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const row = document.createElement("div");
    row.className = "session-summary";
    const time = document.createElement("time");
    time.dateTime = new Date(session.startedAt).toISOString();
    time.textContent = dateLabel(session);
    const result = document.createElement("span");
    result.className = "result";
    result.textContent = stats.remainingMs === 0 ? `${clock(session.goalMs)} complete` : `${clock(stats.activeMs)} / ${clock(session.goalMs)}`;
    row.append(time, result);
    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent = `${stats.pauses.length} pauses / ${precise(stats.restMs)} rest / ${precise(stats.longestHoldMs)} best hold`;
    summary.append(row, meta);
    const description = document.createElement("p");
    description.className = "session-detail";
    description.textContent = `${stats.remainingMs === 0 ? "Goal completed" : "Finished early"}. Plank: ${precise(stats.activeMs)}. Total elapsed: ${precise(session.endedAt - session.startedAt)}.`;
    details.append(summary, description);
    if (stats.pauses.length) {
      const list = document.createElement("ol");
      list.className = "pause-list";
      appendPauses(list, stats.pauses);
      details.append(list);
    }
    return details;
  }));
}

$("goal-form").addEventListener("submit", event => {
  event.preventDefault();
  if (data.current || storageBlocked) return;
  const minutes = Number($("goal-minutes").value);
  const seconds = Number($("goal-seconds").value);
  const goal = (minutes * 60 + seconds) * 1000;
  if (!Number.isInteger(minutes) || !Number.isInteger(seconds) || minutes < 0 || seconds < 0 || seconds > 59 || goal < 10_000 || goal > 3_600_000) {
    error("Choose a goal between 10 seconds and 60 minutes.");
    return;
  }
  data.goalMs = goal;
  if (save()) notify(`Goal set to ${clock(goal)} of plank, excluding breaks.`);
  renderTimer();
  renderHistory();
});

$("primary").addEventListener("click", () => {
  if (reloadRequired) return;
  const now = Date.now();
  if (closeCompleted(now)) { renderTimer(); return; }
  if (!data.current && storageBlocked) return;
  if (!data.current) {
    data.current = newSession(data.goalMs, now, crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random().toString(36).slice(2)}`, localDay(now));
    $("notice").hidden = true;
  } else {
    data.current = togglePause(data.current, now);
  }
  save();
  renderTimer();
  keepScreen();
});

$("finish").addEventListener("click", () => {
  if (!data.current || reloadRequired) return;
  if (!window.confirm("Finish this session early and save it? It will stay in history but will not count as a completed goal.")) return;
  const session = finishEarly(data.current, Date.now());
  data.sessions.push(session);
  data.current = null;
  const saved = save();
  releaseScreen();
  notify(saved ? "Session saved. Every bit of practice counts." : "Session finished, but not saved to browser storage. Export a backup before closing this page.");
  renderTimer();
  renderHistory();
});

$("chart-goal").addEventListener("change", renderCharts);
$("export").addEventListener("click", () => {
  // If loading failed, preserve the original bytes instead of exporting empty fallback state.
  let content = JSON.stringify(data, null, 2);
  if (storageBlocked) {
    try {
      const original = localStorage.getItem(STORAGE_KEY);
      if (original !== null && !data.current && !data.sessions.length) content = original;
    } catch (cause) {
      notify(`Browser storage is inaccessible. Exporting only the data available in this page. ${cause.message}`);
    }
  }
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `plank-tracker-${localDay(Date.now())}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async event => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    if (data.current) throw new Error("Finish your current session before restoring a backup.");
    if (file.size > 10_000_000) throw new Error("This backup is too large. Maximum size is 10 MB.");
    const imported = validateData(JSON.parse(await file.text()));
    if (data.current) throw new Error("Finish your current session before restoring a backup.");
    if (!window.confirm("Replace all history on this device with this backup? Export your current data first if you want to keep it.")) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
    data = imported;
    storageBlocked = false;
    reloadRequired = false;
    $("error").hidden = true;
    syncGoalFields();
    closeCompleted(Date.now());
    renderTimer();
    renderHistory();
    notify("Backup restored. Any restored active timer continues from its recorded timestamps.");
    keepScreen();
  } catch (cause) {
    error(`Could not restore backup: ${cause.message}`);
  } finally {
    event.target.value = "";
  }
});

// Other tabs must not overwrite an in-flight session with stale data.
window.addEventListener("storage", event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  if (event.storageArea !== localStorage || reloadRequired) return;
  try {
    if (event.newValue === null) throw new Error("History was cleared in another tab. Reload before continuing.");
    data = validateData(JSON.parse(event.newValue));
    storageBlocked = false;
    $("error").hidden = true;
    syncGoalFields();
    renderTimer();
    renderHistory();
    if (data.current) keepScreen();
    else releaseScreen();
  } catch (cause) {
    storageBlocked = true;
    reloadRequired = true;
    error(cause.message);
    renderTimer();
    releaseScreen();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    closeCompleted(Date.now());
    renderTimer();
    keepScreen();
  } else releaseScreen();
});
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  $("install").hidden = false;
});
$("install").addEventListener("click", async () => {
  if (!installPrompt) return;
  try {
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("install").hidden = true;
  } catch (cause) {
    error(`Could not open installation: ${cause.message}`);
  }
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").then(() => navigator.serviceWorker.ready).then(() => {
    $("offline-status").textContent = "Offline ready. On Android, use Chrome's menu to install or Add to Home screen.";
  }).catch(cause => {
    $("offline-status").textContent = `Offline setup failed. The app still works online. ${cause.message}`;
  });
} else {
  $("offline-status").textContent = "Android installation and offline use need an HTTPS address. On plain HTTP, keep the page open and connected.";
}

syncGoalFields();
closeCompleted(Date.now());
renderTimer();
renderHistory();
if (data.current) {
  notify("Session recovered. Time away from this page counts as plank unless you tapped Pause first.");
  keepScreen();
}
setInterval(() => {
  closeCompleted(Date.now());
  renderTimer();
  const day = localDay(Date.now());
  if (day !== lastDay) { lastDay = day; renderHistory(); }
}, 200);
