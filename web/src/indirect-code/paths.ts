/** Normalize host paths without relying on the browser's operating system. */
function normalized(path: string): string {
  const slash = path.replace(/\\/g, "/");
  const prefix = /^[a-z]:\//i.test(slash) ? slash.slice(0, 3) : slash.startsWith("//") ? "//" : slash.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of slash.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > (prefix === "//" ? 2 : 0) && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !prefix) parts.push(part);
  }
  return prefix + parts.join("/");
}

function comparable(path: string): string {
  const value = normalized(path);
  return /^[a-z]:/i.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
}

/** Path equality across separator/case styles: `C:\work\TAP` equals
 * `c:/work/tap` (Windows/UNC compare case-insensitively, like the OS),
 * while POSIX paths compare exactly. Use it for daemon round-trips where
 * one side echoes `filepath.Abs` (native `\`) and the other the stored
 * cwd (`/`): strict `===` never converges there and the UI falls back to
 * stale folder status forever. */
export function sameRemotePath(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return comparable(a) === comparable(b);
}

/** Each conversation belongs to exactly one project: the deepest ancestor. */
export function projectForDirectory<T extends { id: string; path: string; protected?:boolean }>(cwd: string, projects: T[]): T | undefined {
  const home = projects.find((p) => p.protected);
  const directory = comparable(cwd === "" || cwd === "~" ? home?.path || "" : home && (cwd.startsWith("~/") || cwd.startsWith("~\\")) ? home.path + cwd.slice(1) : cwd);
  if (!directory) return home;
  let match: T | undefined;
  let length = -1;
  for (const project of projects) {
    const path = comparable(project.path);
    if (!path) continue;
    const prefix = path.endsWith("/") ? path : path + "/";
    if ((directory === path || directory.startsWith(prefix)) && path.length > length) {
      match = project;
      length = path.length;
    }
  }
  return match || home;
}

/** Compact display: replace the session working directory with "." so
 * headers show `cd ./sub && build` instead of the full remote path.
 * A leading `cd . &&` left over by the collapse is redundant noise, so it
 * is stripped (`cd . && build` -> `build`). */
export function collapseCwd(cmd: string, cwd: string): string {
  if (!cmd || !cwd) return cmd;
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base || base === "/") return cmd;
  // Windows compares case-insensitively: `C:\Work` must collapse `c:\work`.
  // Match case-sensitively first (exact), then case-insensitively so the
  // displayed casing is preserved while the cwd prefix still collapses.
  const variants = [base];
  const back = base.replace(/\//g, "\\");
  if (back !== base) variants.push(back);
  let out = cmd;
  for (const v of variants) {
    if (v) out = out.split(v).join(".");
  }
  if (/^[a-z]:[\\/]/i.test(base)) {
    const ci = (hay: string, needle: string): string => {
      let i = hay.toLowerCase().indexOf(needle.toLowerCase());
      while (i >= 0) {
        hay = hay.slice(0, i) + "." + hay.slice(i + needle.length);
        i = hay.toLowerCase().indexOf(needle.toLowerCase(), i + 1);
      }
      return hay;
    };
    for (const v of variants) {
      if (v) out = ci(out, v);
    }
  }
  return out.replace(/^\s*cd\s+\.\s*&&\s*/, "").trimStart() || out.trimStart();
}

export function absoluteRemotePath(path: string, cwd: string, home = ""): string {
  if (home && (path === "~" || path.startsWith("~/") || path.startsWith("~\\"))) path = home + path.slice(1);
  const value = normalized(/^(?:[a-z]:[\\/]|[\\/])/i.test(path) ? path : `${cwd}/${path}`);
  return /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\") ? value.replace(/\//g, "\\") : value;
}

/** True while the session has a turn in flight (sidebar "happening"
 * group). Only the mirrored `status` decides — never timestamps. */
export function isLiveSession(s: {status?: string}): boolean {
  return s.status === "running";
}

function positiveStamp(n: unknown): number {
  return typeof n === "number" && n > 0 ? n : 0;
}

/** Order key of a live session: start of the running turn (updatedAt
 * fallback for sessions that never ran a turn). */
export function sessionLiveKey(s: {lastTurnStartedAt?: number; updatedAt: number}): number {
  return positiveStamp(s.lastTurnStartedAt) || s.updatedAt;
}

/** Order key of a finished session: end of the last turn — never its
 * start. Sessions without a recorded turn end (never ran, or finished
 * before the daemon tracked it) fall back to updatedAt. */
export function sessionFinishedKey(s: {lastTurnStartedAt?: number; lastTurnEndedAt?: number; updatedAt: number}): number {
  return positiveStamp(s.lastTurnEndedAt) || s.updatedAt;
}

/** Sidebar order: live sessions first (running turn start, newest first;
 * session creation breaks ties), then finished sessions (last turn end,
 * newest first; creation breaks ties). Final `id` tie-break keeps the
 * order stable. */
export function compareSessions<
  T extends {id: string; status?: string; createdAt: number; updatedAt: number; lastTurnStartedAt?: number; lastTurnEndedAt?: number},
>(a: T, b: T): number {
  const aLive = isLiveSession(a);
  const bLive = isLiveSession(b);
  if (aLive !== bLive) return aLive ? -1 : 1;
  const key = aLive ? sessionLiveKey : sessionFinishedKey;
  return key(b) - key(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/** Stamp shown next to a sidebar/history row: the same stamp the row is
 * ordered by (turn start while live, turn end once finished). */
export function sessionTimeLabel(s: {status?: string; lastTurnStartedAt?: number; lastTurnEndedAt?: number; updatedAt: number}): number {
  return isLiveSession(s) ? sessionLiveKey(s) : sessionFinishedKey(s);
}

/** Projects ordered by activity: each project ranks by the newest
 * session order key among its 10 most ordered sessions (live sessions
 * contribute their turn start, finished ones their turn end), falling
 * back to creation date when it has no sessions. */
export function projectsByActivity<T extends {id:string; path:string; createdAt:number}>(projects:T[], sessions:{cwd:string; status?:string; updatedAt:number; lastTurnStartedAt?:number; lastTurnEndedAt?:number}[]): T[] {
  const activity = new Map(projects.map((p) => [p.id, p.createdAt]));
  const byProject = new Map<string, {status?:string; updatedAt:number; lastTurnStartedAt?:number; lastTurnEndedAt?:number}[]>();
  for (const session of sessions) {
    const project = projectForDirectory(session.cwd, projects);
    if (!project) continue;
    const list = byProject.get(project.id) ?? [];
    list.push(session);
    byProject.set(project.id, list);
  }
  for (const [id, list] of byProject) {
    // Only the 10 most ordered sessions of the project count for its rank.
    list.sort((a, b) => sessionTimeLabel(b) - sessionTimeLabel(a));
    let rank = 0;
    for (const s of list.slice(0, 10)) rank = Math.max(rank, sessionTimeLabel(s));
    activity.set(id, Math.max(activity.get(id) || 0, rank));
  }
  return [...projects].sort((a,b) => (activity.get(b.id) || 0) - (activity.get(a.id) || 0) || a.id.localeCompare(b.id));
}
