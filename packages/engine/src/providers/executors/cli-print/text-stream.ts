/**
 * Incremental plain-text stdout/stderr line parser for CLIs without stream-json.
 */

export interface TextStreamUpdate {
  activity: string;
  detail: string;
}

export class TextLineStreamParser {
  private buffer = "";

  push(chunk: string): TextStreamUpdate[] {
    this.buffer += chunk;
    const updates: TextStreamUpdate[] = [];

    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      const update = lineToUpdate(line);
      if (update) {
        updates.push(update);
      }
    }

    return updates;
  }

  flush(): TextStreamUpdate[] {
    const line = this.buffer.trim();
    this.buffer = "";
    const update = lineToUpdate(line);
    return update ? [update] : [];
  }
}

function lineToUpdate(line: string): TextStreamUpdate | undefined {
  const text = line.replace(/\s+/g, " ").trim();
  if (!text || text.length < 2) {
    return undefined;
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    return undefined;
  }
  return {
    activity: "running",
    detail: truncate(text, 56),
  };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}
