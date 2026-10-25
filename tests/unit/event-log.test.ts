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
    await first.close();

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
    await log.close();
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
    await recovered.close();

    const reread = await EventLog.open(projectPath, sessionId);
    expect((await reread.readFrom(0)).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it("rejects a newline-terminated invalid final line and leaves the file unchanged", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await log.append(draft(sessionId));
    await log.close();
    const file = sessionPaths(projectPath, sessionId).events;
    await fs.appendFile(file, "not json\n", "utf8");
    const before = await fs.readFile(file);

    await expect(EventLog.open(projectPath, sessionId)).rejects.toThrow(
      "line 2 is not a valid event",
    );
    expect(await fs.readFile(file)).toEqual(before);
  });

  it("rejects a complete line with an unknown event type and leaves the file unchanged", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const paths = sessionPaths(projectPath, sessionId);
    await fs.mkdir(paths.root, { recursive: true });
    const unknown = JSON.stringify({
      seq: 1,
      sessionId,
      at: "2026-01-01T00:00:00.000Z",
      type: "not.a.type",
      data: {},
    });
    await fs.writeFile(paths.events, `${unknown}\n`, "utf8");
    const before = await fs.readFile(paths.events);

    await expect(EventLog.open(projectPath, sessionId)).rejects.toThrow(
      "line 1 is not a valid event",
    );
    expect(await fs.readFile(paths.events)).toEqual(before);
  });

  it("keeps an unterminated final line that is a valid event and adds the newline", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const paths = sessionPaths(projectPath, sessionId);
    await fs.mkdir(paths.root, { recursive: true });
    const event = (seq: number) =>
      JSON.stringify({
        seq,
        sessionId,
        at: "2026-01-01T00:00:00.000Z",
        type: "session.created",
        data: {},
      });
    await fs.writeFile(paths.events, `${event(1)}\n${event(2)}`, "utf8");

    const log = await EventLog.open(projectPath, sessionId);
    expect(log.lastSeq).toBe(2);
    expect(await readEventsFile(projectPath, sessionId)).toMatch(/\n$/);
    expect((await log.readFrom(0)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await log.append(draft(sessionId))).seq).toBe(3);
  });

  it("truncates a multibyte UTF-8 partial tail by byte offset and leaves no tmp files", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    const log = await EventLog.open(projectPath, sessionId);
    await log.append(draft(sessionId, "héllo ✓ 日本"));
    await log.append(draft(sessionId, "héllo ✓ 日本"));
    await log.close();
    const paths = sessionPaths(projectPath, sessionId);
    const before = await fs.readFile(paths.events);

    // Crash mid-write: the partial line ends inside a 3-byte UTF-8 character.
    const partial = Buffer.concat([
      Buffer.from('{"seq":3,"title":"'),
      Buffer.from("日").subarray(0, 2),
    ]);
    await fs.appendFile(paths.events, partial);

    const reopened = await EventLog.open(projectPath, sessionId);
    expect(await fs.readFile(paths.events)).toEqual(before);
    expect(reopened.lastSeq).toBe(2);
    expect((await reopened.readFrom(0)).map((e) => (e.data as { title?: string }).title)).toEqual([
      "héllo ✓ 日本",
      "héllo ✓ 日本",
    ]);
    expect((await reopened.append(draft(sessionId))).seq).toBe(3);
    expect((await fs.readdir(paths.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("recovers from an injected partial write with no seq gap and only valid lines", async () => {
    const projectPath = await makeProject();
    const sessionId = createId();
    let failNext = false;
    const flaky = (async (file: string, data: string, options: BufferEncoding) => {
      if (failNext) {
        failNext = false;
        await fs.appendFile(file, data.slice(0, 10), options);
        throw new Error("disk full");
      }
      await fs.appendFile(file, data, options);
    }) as unknown as typeof fs.appendFile;

    const log = await EventLog.open(projectPath, sessionId, { appendFile: flaky });
    expect((await log.append(draft(sessionId))).seq).toBe(1);

    failNext = true;
    await expect(log.append(draft(sessionId))).rejects.toThrow("disk full");
    expect(log.lastSeq).toBe(1);

    expect((await log.append(draft(sessionId))).seq).toBe(2);
    const lines = (await readEventsFile(projectPath, sessionId)).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => parseEngineEvent(JSON.parse(line))).not.toThrow();
    }
    expect((await log.readFrom(0)).map((e) => e.seq)).toEqual([1, 2]);
    expect(
      (await fs.readdir(sessionPaths(projectPath, sessionId).root)).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("reports the real file line number, counting blank lines", async () => {
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
    await fs.writeFile(paths.events, `${good}\n\nnot json\n`, "utf8");

    await expect(EventLog.open(projectPath, sessionId)).rejects.toThrow(
      "line 3 is not a valid event",
    );
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
