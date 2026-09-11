// Pure logic behind the Windows run-lock ownership check (cli.ts's
// acquireRunLockWindows). Extracted (no fs, no process) so its one subtle
// invariant is tested: a transient READ failure must map to 'unknown', never
// to 'reclaimed'. The heartbeat and release paths branch on these three
// states, and collapsing 'unknown' into 'reclaimed' (or 'mine') is exactly
// the bug that would either hand a live lock away or delete a reclaimer's lock.
type LockOwnership = "mine" | "reclaimed" | "unknown";

/**
 * @param raw    lock-file contents, or null if the file could not be read
 *               (ENOENT, EBUSY under AV scan, …)
 * @param ownPid this process's pid
 */
export function parseLockOwner(raw: string | null, ownPid: number): LockOwnership {
  if (raw === null) return "unknown"; // read failed — do NOT assume reclaimed
  let pid: number;
  try { pid = Number(JSON.parse(raw)?.pid); } catch { return "unknown"; } // corrupt/partial write
  if (!Number.isFinite(pid)) return "unknown";
  return pid === ownPid ? "mine" : "reclaimed";
}
