import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { detectPlatform, keymapEntries } from "../../keymap.js";
import { holdTab, restoreFocus, useEscapeKey } from "./dialog.js";

/** The `?` dialog: the keyboard map for this platform. Escape or Close returns focus to the opener. */
export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [opener] = useState<Element | null>(() => document.activeElement);
  const entries = useMemo(() => keymapEntries(detectPlatform()), []);

  useEffect(() => {
    closeRef.current?.focus();
    return () => restoreFocus(opener);
  }, [opener]);
  useEscapeKey(onClose);

  // Close on a click on the backdrop itself. Other mousedowns keep focus on the Close button.
  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
      return;
    }
    if (event.target !== closeRef.current) event.preventDefault();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onBackdropMouseDown}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="help" onKeyDown={holdTab}>
        <div className="help-head">
          <h2 id={titleId} className="help-title">
            Keyboard shortcuts
          </h2>
          <button ref={closeRef} type="button" className="help-close" onClick={onClose}>
            Close
          </button>
        </div>
        <dl className="help-keys">
          {entries.map((entry) => (
            <div className="help-row" key={entry.action}>
              <dt>
                <kbd>{entry.keys}</kbd>
              </dt>
              <dd>{entry.action}</dd>
            </div>
          ))}
        </dl>
        <p className="help-note">Shortcuts are off while you type in a field.</p>
      </div>
    </div>
  );
}
