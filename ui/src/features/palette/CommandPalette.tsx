import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { detectPlatform, isComposing, shortcutLabel } from "../../keymap.js";
import { useEngine } from "../../store/context.js";
import { selectHasNegotiation, selectLeadBoard } from "../../store/selectors.js";
import { holdTab, restoreFocus, useEscapeKey } from "./dialog.js";
import { rankItems } from "./fuzzy.js";
import { buildPaletteItems, type PaletteItem } from "./items.js";

/** Most results drawn at once; the status line says how many more there are. */
export const MAX_RESULTS = 50;

/** Move focus to a view's root and scroll it into view. False when the view is not on screen. */
function focusView(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: "start" });
  return true;
}

/** Move focus to the main panel after a run is picked, so focus does not fall back to the opener. */
function focusMain(): boolean {
  const main = document.querySelector<HTMLElement>(".main");
  if (!main) return false;
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  main.focus({ preventScroll: true });
  return true;
}

/** An HTML id for a result: the item id with anything but word characters replaced. */
function domId(listId: string, item: PaletteItem): string {
  return `${listId}-${item.id.replace(/[^\w-]/g, "_")}`;
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
  // Set when a run moved focus itself, so closing must not send focus back to the opener.
  const handledRef = useRef(false);
  const [opener] = useState<Element | null>(() => document.activeElement);
  const platform = useMemo(() => detectPlatform(), []);

  const items = useMemo(
    () => buildPaletteItems({ sessions, recentIds, hasSeats, hasNegotiation, hasLeadBoard }),
    [sessions, recentIds, hasSeats, hasNegotiation, hasLeadBoard],
  );
  const ranked = useMemo(() => rankItems(items, query), [items, query]);
  const shown = ranked.slice(0, MAX_RESULTS);
  const more = ranked.length - shown.length;
  const index = shown.length === 0 ? 0 : Math.min(active, shown.length - 1);
  const activeItem = shown[index];
  const activeId = activeItem ? domId(listId, activeItem) : undefined;
  const status = notice || (more > 0 ? `${more} more — keep typing to narrow the results` : "");

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (!handledRef.current) restoreFocus(opener);
    };
  }, [opener]);
  useEscapeKey(onClose);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const run = (item: PaletteItem) => {
    const { action } = item;
    if (action.kind === "blocked") {
      // Disabled: say why, do nothing else. The palette stays open.
      setNotice(`${item.label}: ${action.reason}`);
      return;
    }
    if (action.kind === "session") {
      select(action.sessionId);
      handledRef.current = focusMain();
    } else {
      handledRef.current = focusView(action.selector);
      if (!handledRef.current) {
        setNotice(`${item.label} is not on screen`);
        return;
      }
    }
    onClose();
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // React's synthetic event has no isComposing; the native event does.
    if (isComposing(event.nativeEvent)) return;
    const count = shown.length;
    if (event.key === "ArrowDown" && count > 0) {
      event.preventDefault();
      setActive((index + 1) % count);
    } else if (event.key === "ArrowUp" && count > 0) {
      event.preventDefault();
      setActive((index - 1 + count) % count);
    } else if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      run(activeItem);
    }
  };

  // Close on a click on the backdrop itself. Other mousedowns keep focus on the input.
  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
      return;
    }
    if (event.target !== inputRef.current) event.preventDefault();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onBackdropMouseDown}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="palette" onKeyDown={holdTab}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search sessions, views and commands"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
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
            const reason = item.action.kind === "blocked" ? item.action.reason : undefined;
            const id = domId(listId, item);
            const reasonId = `${id}-reason`;
            return (
              <li
                key={item.id}
                id={id}
                role="option"
                aria-selected={i === index}
                aria-disabled={reason ? "true" : undefined}
                aria-describedby={reason ? reasonId : undefined}
                className={`palette-option${i === index ? " is-active" : ""}${reason ? " is-disabled" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(item)}
              >
                <span className="palette-main">
                  <span className="palette-label">{item.label}</span>
                  {item.detail ? <span className="palette-detail">{item.detail}</span> : null}
                </span>
                <span className="palette-side">
                  <span className="palette-meta">{item.group}</span>
                  {reason ? (
                    <span id={reasonId} className="palette-reason">
                      {reason}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        {shown.length === 0 ? <p className="palette-empty">No matches for “{query}”.</p> : null}
        <p role="status" className="palette-notice">
          {status}
        </p>
        <p className="palette-hint">
          {shortcutLabel(platform, "K")} opens · ↑ ↓ move · Enter runs · Esc closes
        </p>
      </div>
    </div>
  );
}
