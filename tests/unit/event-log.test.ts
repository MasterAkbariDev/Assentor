import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createId, EventLog, parseEngineEvent, sessionPaths } from "../../src/index.js";
import type { EngineEventDraft } from "../../src/index.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "event-log-"));
  tempDirs.push(dir);
  return dir;
}

function draft(sessionId: string, title = "t"): EngineEventDraft {
  return { sessionId, type: "session.created", data: { title } };
}

async function readEventsFile(projectPath: string, sessionId: string): Promise<string> {
  return fs.readFile(sessionPaths(projectPath, sessionId).events, "utf8");
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("sessionPaths", () => {
  it("rejects a session id that is not a UUID", () => {
    expect(() => sessionPaths("/tmp/p", "../escape")).toThrow(
      "Invalid session id: ../escape",
    );
  });

  it("places the events file under .assentor/sessions/<id>", () => {
    const id = createId();
    const paths = sessionPaths("/tmp/p", id);
    expect(paths.root).toBe(path.join("/tmp/p", ".assentor", "sessions", id));
    expect(paths.events).toBe(path.join(paths.root, "events.ndjson"));
  });
});

describe("EventLog", () => {
  it("100 concurrent appends get seq 1..100 with no gaps or duplicates", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);

    const events = await Promise.all(
      Array.from({ length: 100 }, () => log.append(draft(sessionId))),
    );

    const seqs = events.map((event) => event.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(log.lastSeq).toBe(100);

    const lines = (await readEventsFile(projectPath, sessionId))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(100);
    for (const line of lines) {
      expect(() => parseEngineEvent(JSON.parse(line))).not.toThrow();
    }
  });

  it("reopening recovers lastSeq and the next append continues the sequence", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const first = await EventLog.open(projectPath, sessionId);
    for (let i = 0; i < 5; i += 1) {
      await first.append(draft(sessionId));
    }

    const reopened = await EventLog.open(projectPath, sessionId);
    expect(reopened.lastSeq).toBe(5);

    const next = await reopened.append(draft(sessionId));
    expect(next.seq).toBe(6);
    expect((await reopened.readFrom(0)).map((event) => event.seq)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("ignores a truncated final line and continues numbering after the last valid event", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    for (let i = 0; i < 3; i += 1) {
      await log.append(draft(sessionId));
    }
    // Simulate a crash mid-write: a partial JSON line with no newline.
    await fs.appendFile(
      sessionPaths(projectPath, sessionId).events,
      '{"seq":4,"sessionId":"',
      "utf8",
    );

    const recovered = await EventLog.open(projectPath, sessionId);
    expect(recovered.lastSeq).toBe(3);
    expect(await recovered.readFrom(0)).toHaveLength(3);

    const next = await recovered.append(draft(sessionId));
    expect(next.seq).toBe(4);

    const reread = await EventLog.open(projectPath, sessionId);
    expect((await reread.readFrom(0)).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it("drops an invalid final line that ends with a newline", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await log.append(draft(sessionId));
    await fs.appendFile(sessionPaths(projectPath, sessionId).events, "not json\n", "utf8");

    const recovered = await EventLog.open(projectPath, sessionId);
    expect(recovered.lastSeq).toBe(1);
    expect(await readEventsFile(projectPath, sessionId)).not.toContain("not json");
  });

  it("readFrom(n) returns exactly the events after n, in order", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    for (let i = 0; i < 10; i += 1) {
      await log.append(draft(sessionId));
    }

    expect((await log.readFrom(7)).map((event) => event.seq)).toEqual([8, 9, 10]);
    expect(await log.readFrom(10)).toEqual([]);
  });

  it("reads CRLF line endings", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const paths = sessionPaths(projectPath, sessionId);
    await fs.mkdir(paths.root, { recursive: true });
    const lines = [1, 2].map((seq) =>
      JSON.stringify({
        seq,
        sessionId,
        at: "2026-01-01T00:00:00.000Z",
        type: "session.created",
        data: {},
      }),
    );
    await fs.writeFile(paths.events, `${lines.join("\r\n")}\r\n`, "utf8");

    const log = await EventLog.open(projectPath, sessionId);
    expect(log.lastSeq).toBe(2);
    expect((await log.readFrom(0)).map((event) => event.seq)).toEqual([1, 2]);
  });

  it("throws on a corrupt line that is not the final line", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const paths = sessionPaths(projectPath, sessionId);
    await fs.mkdir(paths.root, { recursive: true });
    const good = JSON.stringify({
      seq: 1,
      sessionId,
      at: "2026-01-01T00:00:00.000Z",
      type: "session.created",
      data: {},
    });
    await fs.writeFile(paths.events, `${good}\nnot json\n${good}\n`, "utf8");

    await expect(EventLog.open(projectPath, sessionId)).rejects.toThrow(
      "line 2 is not a valid event",
    );
  });

  it("rejects a draft whose sessionId does not match the log", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await expect(log.append(draft(createId()))).rejects.toThrow(
      "does not match log",
    );
    expect(log.lastSeq).toBe(0);
  });

  it("keeps a supplied at and fills one when missing", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    const fixed = await log.append({ ...draft(sessionId), at: "2026-01-01T00:00:00.000Z" });
    expect(fixed.at).toBe("2026-01-01T00:00:00.000Z");
    const filled = await log.append(draft(sessionId));
    expect(Number.isNaN(Date.parse(filled.at))).toBe(false);
  });
});
