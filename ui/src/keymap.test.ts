// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { detectPlatform, isComposing, isHelpKey, isPaletteKey, isTextEntry, isTypingTarget, keymapEntries, shortcutLabel } from "./keymap.js";

const plain = { key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("platform labels", () => {
  it("uses ⌘ on macOS and Ctrl elsewhere, through one helper", () => {
    expect(shortcutLabel("mac", "K")).toBe("⌘K");
    expect(shortcutLabel("other", "K")).toBe("Ctrl+K");
  });

  it("detects macOS from the platform string, then the user agent", () => {
    expect(detectPlatform({ platform: "MacIntel", userAgent: "" })).toBe("mac");
    expect(detectPlatform({ platform: "", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS)" })).toBe("mac");
    expect(detectPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" })).toBe("other");
    expect(detectPlatform(undefined)).toBe("other");
  });

  it("lists the palette shortcut with the platform's label in the help rows", () => {
    expect(keymapEntries("mac")[0]!.keys).toBe("⌘K");
    expect(keymapEntries("other")[0]!.keys).toBe("Ctrl+K");
  });
});

describe("shortcut matchers", () => {
  it("matches Ctrl+K or ⌘K by key or by physical code, and nothing with Alt or Shift added", () => {
    expect(isPaletteKey({ ...plain, key: "k", ctrlKey: true })).toBe(true);
    expect(isPaletteKey({ ...plain, key: "K", metaKey: true })).toBe(true);
    expect(isPaletteKey({ ...plain, key: "л", code: "KeyK", ctrlKey: true })).toBe(true);
    expect(isPaletteKey({ ...plain, key: "k" })).toBe(false);
    expect(isPaletteKey({ ...plain, key: "k", ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it("matches a bare ? and not a modified one", () => {
    expect(isHelpKey({ ...plain, key: "?", shiftKey: true })).toBe(true);
    expect(isHelpKey({ ...plain, key: "?", ctrlKey: true })).toBe(false);
    expect(isHelpKey({ ...plain, key: "/" })).toBe(false);
  });

  it("treats inputs, text areas and editable regions as text entry; a select is not text entry", () => {
    for (const tag of ["input", "textarea"]) {
      const el = document.createElement(tag);
      document.body.append(el);
      expect(isTextEntry(el)).toBe(true);
    }
    const editable = document.createElement("div");
    document.body.append(editable);
    expect(isTextEntry(editable)).toBe(false);
    // jsdom does not implement isContentEditable, so the flag is stubbed.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTextEntry(editable)).toBe(true);

    const select = document.createElement("select");
    document.body.append(select);
    expect(isTextEntry(select)).toBe(false);
    expect(isTypingTarget(select)).toBe(true);
    const button = document.createElement("button");
    document.body.append(button);
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("ignores keys that finish an IME composition", () => {
    expect(isComposing({ isComposing: true })).toBe(true);
    expect(isComposing({ keyCode: 229 })).toBe(true);
    expect(isComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
