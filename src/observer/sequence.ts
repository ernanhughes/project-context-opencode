/**
 * Persistent per-session request ordering.
 *
 * The capture record carries `invocation_sequence`, a per-session counter. Held only in
 * memory it restarts at 1 whenever the harness process restarts, which the analysis
 * (correctly) treats as an incomplete session. Long sessions are the ones most likely to
 * span a restart, so an in-memory counter would bias the corpus toward short traces.
 *
 * Design, all local, deterministic, no network:
 *
 * - One small state file per session, named from a hash of the session id, so sequence
 *   state can never leak between sessions.
 * - The file holds the last number handed out and a checksum over (session, number), so
 *   a damaged or foreign file is detected instead of trusted.
 * - Written atomically: write a temporary file, then rename over the state file.
 * - **Reserve before recording.** The number is persisted before the record is appended.
 *   A crash in between leaves a gap in the spool, which the analysis reports as a lost
 *   record. It can never cause a number to be handed out twice.
 * - On the first request for a session in this process the state is reconciled with the
 *   spool itself: the next number is one more than the larger of the persisted value and
 *   the highest sequence already in the spool for that session. Missing state is therefore
 *   recovered from the spool, and stale state cannot cause reuse.
 * - If the state is damaged and the spool cannot vouch for the session, ordering is
 *   unrecoverable. A control record is appended saying so and numbering starts again at 1.
 *   The session is then incomplete by rule. Order is never invented.
 *
 * Two processes writing the same session at once is not supported.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const SEQUENCE_STATE_SCHEMA = "project_context.sequence_state.v1";
export const CONTROL_SCHEMA = "project_context.opencode_capture.control.v1";
export const STATE_DIR = "sequence-state";

export type Recovery =
  | "in_process" // already known in this process
  | "state" // persisted state was intact and agreed with the spool
  | "spool" // state missing, stale or damaged; recovered from the spool
  | "fresh" // no state and no spool records: a new session
  | "unrecoverable"; // state damaged and no spool evidence: ordering lost

export type Reservation = {
  sequence: number;
  recovery: Recovery;
};

type State = { schema: string; session: string; last: number; check: string };

function checksum(session: string, last: number): string {
  return createHash("sha256")
    .update(`${SEQUENCE_STATE_SCHEMA}|${session}|${last}`)
    .digest("hex");
}

function sessionKey(sessionId: string | null): string {
  return sessionId === null ? "unlinked" : `session:${sessionId}`;
}

function statePath(spoolDir: string, key: string): string {
  const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(spoolDir, STATE_DIR, `${name}.json`);
}

type Loaded =
  { kind: "missing" } | { kind: "damaged" } | { kind: "ok"; last: number };

function loadState(path: string, key: string): Loaded {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as State;
    const ok =
      raw.schema === SEQUENCE_STATE_SCHEMA &&
      raw.session === key &&
      Number.isInteger(raw.last) &&
      raw.last >= 0 &&
      raw.check === checksum(key, raw.last);
    return ok ? { kind: "ok", last: raw.last } : { kind: "damaged" };
  } catch {
    return { kind: "damaged" };
  }
}

/** Atomic replace: a reader sees the old file or the new one, never half of either. */
function persist(path: string, key: string, last: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const body: State = {
    schema: SEQUENCE_STATE_SCHEMA,
    session: key,
    last,
    check: checksum(key, last),
  };
  writeFileSync(temp, JSON.stringify(body), "utf-8");
  renameSync(temp, path);
}

/** Fixed read bound for recovery. The spool may be arbitrarily large. */
export const SPOOL_SCAN_CHUNK_BYTES = 64 * 1024;

/** Scan one append-only JSONL file without materializing either the file or its lines. */
function highestInFile(file: string, needle: string): number | null {
  const fd = openSync(file, "r");
  const bytes = Buffer.allocUnsafe(SPOOL_SCAN_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  // Enough overlap for a needle split across chunks plus every safe integer digit.
  const overlap = needle.length + String(Number.MAX_SAFE_INTEGER).length;
  let tail = "";
  let best: number | null = null;

  const inspect = (text: string): void => {
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const start = at + needle.length;
      const match = /^\d+/.exec(text.slice(start));
      if (match) {
        const n = Number(match[0]);
        if (Number.isSafeInteger(n) && (best === null || n > best)) best = n;
      }
      from = start;
    }
  };

  try {
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, null);
      if (count === 0) break;
      const text = tail + decoder.write(bytes.subarray(0, count));
      inspect(text);
      tail = text.slice(-overlap);
    }
    const final = tail + decoder.end();
    inspect(final);
  } finally {
    closeSync(fd);
  }
  return best;
}

/** Highest `invocation_sequence` the spool already holds for a session, or null.
 * Recovery is bounded-memory: only a fixed byte chunk and small overlap are retained. */
export function highestInSpool(
  spoolDir: string,
  sessionId: string | null,
): number | null {
  if (!existsSync(spoolDir)) return null;
  const needle = `"session_id":${JSON.stringify(sessionId)},"invocation_sequence":`;
  let best: number | null = null;
  for (const entry of readdirSync(spoolDir)) {
    const day = join(spoolDir, entry);
    if (entry === STATE_DIR || !statSync(day).isDirectory()) continue;
    const file = join(day, "captures.jsonl");
    if (!existsSync(file)) continue;
    const inFile = highestInFile(file, needle);
    if (inFile !== null && (best === null || inFile > best)) best = inFile;
  }
  return best;
}

export function appendControl(
  spoolDir: string,
  event: string,
  sessionId: string | null,
  at: string,
): void {
  const day = at.slice(0, 10);
  mkdirSync(join(spoolDir, day), { recursive: true });
  const line = JSON.stringify({
    schema: CONTROL_SCHEMA,
    event,
    session_id: sessionId,
    captured_at: at,
  });
  appendFileSync(join(spoolDir, day, "captures.jsonl"), line + "\n", "utf-8");
}

export class SequenceStore {
  private readonly known = new Map<string, number>();
  private readonly spoolDir: string;
  private readonly now: () => string;

  constructor(
    spoolDir: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.spoolDir = spoolDir;
    this.now = now;
  }

  /** Reserve the next sequence number for a session. Persisted before it is returned. */
  next(sessionId: string | null): Reservation {
    const key = sessionKey(sessionId);
    const path = statePath(this.spoolDir, key);
    let recovery: Recovery = "in_process";
    let last = this.known.get(key);

    if (last === undefined) {
      const state = loadState(path, key);
      const spool = highestInSpool(this.spoolDir, sessionId);
      if (state.kind === "ok") {
        last = Math.max(state.last, spool ?? 0);
        recovery = spool !== null && spool > state.last ? "spool" : "state";
      } else if (spool !== null) {
        last = spool;
        recovery = "spool";
      } else if (state.kind === "damaged") {
        // Damaged state and nothing in the spool to check it against.
        last = 0;
        recovery = "unrecoverable";
        appendControl(
          this.spoolDir,
          "sequence_state_lost",
          sessionId,
          this.now(),
        );
      } else {
        last = 0;
        recovery = "fresh";
      }
    }

    const sequence = last + 1;
    persist(path, key, sequence);
    this.known.set(key, sequence);
    return { sequence, recovery };
  }
}
