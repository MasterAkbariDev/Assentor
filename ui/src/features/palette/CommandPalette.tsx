import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { detectPlatform, shortcutLabel } from "../../keymap.js";
import { useEngine } from "../../store/context.js";
import { selectHasNegotiation, selectLeadBoard } from "../../store/selectors.js";
import { holdTab, restoreFocus, useEscapeKey } from "./dialog.js";
import { rankItems } from "./fuzzy.js";
import { buildPaletteItems, type PaletteItem } from "./items.js";

/** Move focus to a view's root and scroll it into view. */
function focusView(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: "start" });
}

/**
 * Ctrl/⌘+K command palette (T04-14p, watch-only). A modal combobox over a listbox:
 * arrows move the highlight (aria-activedescendant), Enter runs it, Escape closes
 * and returns focus to the opener. Write actions are listed disabled with the reason.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const sessions = useEngine((s) => s.sessions);
  const recentIds = useEngine((s) => s.recentIds);
  const select = useEngine((s) => s.select);
  const hasSeats = useEngine((s) => Object.keys(s.session?.seats ?? {}).length > 0);
  const hasNegotiation = useEngine(selectHasNegotiation);
  const hasLeadBoard = useEngine((s) => selectLeadBoard(s) !== undefined);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState("");
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // A view run moves focus itself, so closing must not send it back to the opener.
  const handledRef = useRef(false);
  const [opener] = useState<Element | null>(() => document.activeElement);
  const platform = useMemo(() => detectPlatform(), []);

  const items = useMemo(
    () => buildPaletteItems({ sessions, recentIds, hasSeats, hasNegotiation, hasLeadBoard }),
    [sessions, recentIds, hasSeats, hasNegotiation, hasLeadBoard],
  );
  const shown = useMemo(() => rankItems(items, query), [items, query]);
  const index = shown.length === 0 ? 0 : Math.min(active, shown.length - 1);
  const optionId = (i: number) => `${listId}-opt-${i}`;

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (!handledRef.current) restoreFocus(opener);
    };
  }, [opener]);
  useEscapeKey(onClose);

  useEffect(() => {
    document.getElementById(optionId(index))?.scrollIntoView?.({ block: "nearest" });
  }, [index, listId]);

  const run = (item: PaletteItem) => {
    const { action } = item;
    if (action.kind === "blocked") {
      // Disabled: say why, do nothing else. The palette stays open.
      setNotice(`${item.label}: ${action.reason}`);
      return;
    }
    if (action.kind === "session") {
      select(action.sessionId);
    } else {
      handledRef.current = true;
      focusView(action.selector);
    }
    onClose();
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = shown.length;
    if (event.key === "ArrowDown" && count > 0) {
      event.preventDefault();
      setActive((index + 1) % count);
    } else if (event.key === "ArrowUp" && count > 0) {
      event.preventDefault();
      setActive((index - 1 + count) % count);
    } else if (event.key === "Enter") {
      const item = shown[index];
      if (item) {
        event.preventDefault();
        run(item);
      }
    }
  };

  return (
    <div className="palette-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="palette" onKeyDown={holdTab}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search sessions, views and commands"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown.length > 0 ? optionId(index) : undefined}
          className="palette-input"
          placeholder="Search sessions, views and commands"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setNotice("");
          }}
          onKeyDown={onInputKeyDown}
        />
        <ul id={listId} role="listbox" aria-label="Results" className="palette-list">
          {shown.map((item, i) => {
            const blocked = item.action.kind === "blocked";
            return (
              <li
                key={item.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === index}
                aria-disabled={blocked ? "true" : undefined}
                className={`palette-option${i === index ? " is-active" : ""}${blocked ? " is-disabled" : ""}`}
                onMouseMove={() => setActive(i)}
                onClick={() => run(item)}
              >
                <span className="palette-label">{item.label}</span>
                <span className="palette-meta">
                  {item.group}
                  {item.detail ? ` · ${item.detail}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
        {shown.length === 0 ? <p className="palette-empty">No matches for “{query}”.</p> : null}
        <p role="status" className="palette-notice">
          {notice}
        </p>
        <p className="palette-hint">
          {shortcutLabel(platform, "K")} opens · ↑ ↓ move · Enter runs · Esc closes
        </p>
      </div>
    </div>
  );
}
