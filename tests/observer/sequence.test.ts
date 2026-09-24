/**
 * Persistent sequence ordering: restart, recovery, corruption, isolation.
 * Run: npm test
 */

import { deepEqual, equal, ok } from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONTROL_SCHEMA,
  SequenceStore,
  STATE_DIR,
  highestInSpool,
} from "../../src/observer/sequence.ts";

const DAY = "2030-01-01";
const AT = `${DAY}T00:00:00.000Z`;

function spool(): string {
  return mkdtempSync(join(tmpdir(), "seq-"));
}

/** What the adapter appends for one record: enough of it for the store to read back. */
function appendRecordLine(
  dir: string,
  session: string | null,
  sequence: number,
): void {
  mkdirSync(join(dir, DAY), { recursive: true });
  const line = JSON.stringify({
    schema: "project_context.opencode_capture.v2",
    capture_id: `c${sequence}`,
    session_id: session,
    invocation_sequence: sequence,
    messages: [{ text: `"session_id":"${session}","invocation_sequence":999` }],
  });
  appendFileSync(join(dir, DAY, "captures.jsonl"), line + "\n", "utf-8");
}

function stateFiles(dir: string): string[] {
  return readdirSync(join(dir, STATE_DIR)).filter((f) => f.endsWith(".json"));
}

test("numbers run 1..N and stay monotonic across a simulated restart", () => {
  const dir = spool();
  try {
    const first = new SequenceStore(dir, () => AT);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = first.next("ses-a");
      seen.push(r.sequence);
      appendRecordLine(dir, "ses-a", r.sequence);
    }
    // The harness restarts: a new store, nothing in memory.
    const second = new SequenceStore(dir, () => AT);
    for (let i = 0; i < 3; i++) {
      const r = second.next("ses-a");
      seen.push(r.sequence);
      appendRecordLine(dir, "ses-a", r.sequence);
    }
    deepEqual(seen, [1, 2, 3, 4, 5, 6]);
    equal(second.next("ses-a").recovery, "in_process");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart reports that it recovered from intact state", () => {
  const dir = spool();
  try {
    const a = new SequenceStore(dir, () => AT);
    equal(a.next("ses-a").recovery, "fresh");
    appendRecordLine(dir, "ses-a", 1);
    const b = new SequenceStore(dir, () => AT);
    const r = b.next("ses-a");
    deepEqual([r.sequence, r.recovery], [2, "state"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions never share or leak sequence state", () => {
  const dir = spool();
  try {
    const s = new SequenceStore(dir, () => AT);
    deepEqual(
      [
        s.next("ses-a").sequence,
        s.next("ses-a").sequence,
        s.next("ses-b").sequence,
      ],
      [1, 2, 1],
    );
    equal(stateFiles(dir).length, 2);
    // A brand new store, the other session first: still independent.
    const t = new SequenceStore(dir, () => AT);
    equal(t.next("ses-b").sequence, 2);
    equal(t.next("ses-a").sequence, 3);
    // The unlinked scope is its own session too.
    equal(new SequenceStore(dir, () => AT).next(null).sequence, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing state is recovered from the spool, never restarted at 1", () => {
  const dir = spool();
  try {
    for (const n of [1, 2, 3, 4]) appendRecordLine(dir, "ses-a", n);
    appendRecordLine(dir, "ses-b", 9);
    const r = new SequenceStore(dir, () => AT).next("ses-a");
    deepEqual([r.sequence, r.recovery], [5, "spool"]);
    equal(highestInSpool(dir, "ses-a"), 5 - 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the spool scan reads the record's own fields, not quoted text inside messages", () => {
  const dir = spool();
  try {
    appendRecordLine(dir, "ses-a", 2); // its message text quotes sequence 999
    equal(highestInSpool(dir, "ses-a"), 2);
    equal(highestInSpool(dir, "ses-none"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state behind the spool cannot cause a reused number", () => {
  const dir = spool();
  try {
    const a = new SequenceStore(dir, () => AT);
    a.next("ses-a"); // state says 1
    for (const n of [1, 2, 3]) appendRecordLine(dir, "ses-a", n); // spool says 3
    const r = new SequenceStore(dir, () => AT).next("ses-a");
    deepEqual([r.sequence, r.recovery], [4, "spool"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserve-before-record: a crash between reserving and appending leaves a gap, not a duplicate", () => {
  const dir = spool();
  try {
    const a = new SequenceStore(dir, () => AT);
    appendRecordLine(dir, "ses-a", a.next("ses-a").sequence); // 1, recorded
    a.next("ses-a"); // 2 reserved, then the process dies before appending
    const b = new SequenceStore(dir, () => AT);
    const r = b.next("ses-a");
    equal(r.sequence, 3); // 2 is never handed out again
    ok(highestInSpool(dir, "ses-a") === 1); // and the spool shows the hole for the analysis
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("damaged state with spool evidence is recovered; every kind of damage is detected", () => {
  const damages: Array<[string, (path: string) => void]> = [
    ["not json", (p) => writeFileSync(p, "{not json", "utf-8")],
    ["empty file", (p) => writeFileSync(p, "", "utf-8")],
    [
      "wrong checksum",
      (p) => {
        const s = JSON.parse(readFileSync(p, "utf-8"));
        s.last = 40;
        writeFileSync(p, JSON.stringify(s), "utf-8");
      },
    ],
    [
      "another session's file",
      (p) => {
        const s = JSON.parse(readFileSync(p, "utf-8"));
        s.session = "session:ses-other";
        writeFileSync(p, JSON.stringify(s), "utf-8");
      },
    ],
  ];
  for (const [label, damage] of damages) {
    const dir = spool();
    try {
      const a = new SequenceStore(dir, () => AT);
      appendRecordLine(dir, "ses-a", a.next("ses-a").sequence);
      appendRecordLine(dir, "ses-a", a.next("ses-a").sequence);
      damage(join(dir, STATE_DIR, stateFiles(dir)[0]!));
      const r = new SequenceStore(dir, () => AT).next("ses-a");
      deepEqual([r.sequence, r.recovery], [3, "spool"], label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("damaged state with no spool evidence is unrecoverable: recorded, not invented", () => {
  const dir = spool();
  try {
    new SequenceStore(dir, () => AT).next("ses-a"); // state written, nothing appended
    writeFileSync(
      join(dir, STATE_DIR, stateFiles(dir)[0]!),
      "garbage",
      "utf-8",
    );
    const r = new SequenceStore(dir, () => AT).next("ses-a");
    equal(r.recovery, "unrecoverable");
    const lines = readFileSync(join(dir, DAY, "captures.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    equal(lines.length, 1);
    deepEqual(
      [lines[0].schema, lines[0].event, lines[0].session_id],
      [CONTROL_SCHEMA, "sequence_state_lost", "ses-a"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a leftover temporary file from a crashed write does not disturb the state", () => {
  const dir = spool();
  try {
    const a = new SequenceStore(dir, () => AT);
    appendRecordLine(dir, "ses-a", a.next("ses-a").sequence);
    writeFileSync(
      join(dir, STATE_DIR, "stale.1234.tmp"),
      "{half written",
      "utf-8",
    );
    const r = new SequenceStore(dir, () => AT).next("ses-a");
    deepEqual([r.sequence, r.recovery], [2, "state"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state files carry no content, only the session key, a number and a checksum", () => {
  const dir = spool();
  try {
    new SequenceStore(dir, () => AT).next("ses-a");
    const body = JSON.parse(
      readFileSync(join(dir, STATE_DIR, stateFiles(dir)[0]!), "utf-8"),
    );
    deepEqual(Object.keys(body).sort(), ["check", "last", "schema", "session"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
