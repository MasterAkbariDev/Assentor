import type { ButtonHTMLAttributes } from "react";

/**
 * A write control that stays focusable when it can't run: `aria-disabled`, no click, and
 * `aria-describedby` pointing at the visible reason (`reasonId`). With no `reason` it is a normal button.
 */
export function WriteButton({
  reason,
  reasonId,
  busy,
  onClick,
  className = "write-btn",
  ...rest
}: { reason?: string; reasonId?: string; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const inert = reason !== undefined || busy === true;
  return (
    <button
      {...rest}
      className={className}
      aria-disabled={inert ? true : undefined}
      aria-describedby={reason !== undefined ? reasonId : rest["aria-describedby"]}
      onClick={(event) => {
        if (inert) return event.preventDefault();
        onClick?.(event);
      }}
    />
  );
}
