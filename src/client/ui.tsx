// Shared control recipes and the two shells both routes need (a dialog and an
// empty state). Every value here is a token: no raw hex, no fixed px, so an
// app or agency rebrands by overriding a custom property in styles.css and
// every control below reflows.
//
// Buttons: 28px tall, 8px corners, one SOLID (ink) action per screen.
// Everything else is secondary (white with a raised shadow ring) or ghost.

import { useEffect, useRef } from "react";

const btnBase =
  "inline-flex items-center gap-1.5 h-7 rounded-sm text-button whitespace-nowrap " +
  "disabled:opacity-50 disabled:pointer-events-none";

/** The one solid action on a screen. A leading icon sits 2px tighter. */
export const btnPrimary = `${btnBase} pl-1.5 pr-2 bg-primary text-on-primary hover:bg-primary-hover shadow-button`;
/** The default for everything else: white, edged by a shadow ring not a border. */
export const btnSecondary = `${btnBase} pl-1.5 pr-2 bg-surface text-foreground hover:bg-surface-sunken shadow-raised`;
/** Cancel, toolbar view-state chips, row actions. */
export const btnGhost = `${btnBase} px-2 text-muted hover:bg-surface-sunken hover:text-foreground`;
/** Destructive: tint at rest, fills solid on hover. */
export const btnDanger = `${btnBase} px-2 bg-danger-tint text-danger hover:bg-danger-solid hover:text-on-primary`;
/** Icon-only control (row actions, transport). Square, so it stays optical. */
export const btnIcon =
  "inline-grid place-items-center w-7 h-7 rounded-sm text-muted hover:bg-surface-sunken hover:text-foreground " +
  "disabled:opacity-40 disabled:pointer-events-none";

/** A stretched button centres its content: the tighter leading-icon padding is
 *  an optical correction that only applies when the button hugs its label. */
export const stretch = "w-full justify-center px-2";

/** A resting card: white, edged by an inset ring at 12px. Never a drop shadow. */
export const card = "rounded-md bg-surface shadow-edge";

/** A fact (file kind, track, plan): quiet gray, 4px corners, no border. */
export const chip =
  "inline-flex items-center rounded-xs bg-surface-sunken px-2 py-1 text-fine text-muted";

// ── status badge ────────────────────────────────────────────────────────────

const BADGE: Record<string, string> = {
  info: "bg-info-tint text-info",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
};

/** A signal that demands attention: tinted fill, same-hue text, no border. */
export function Badge({ tone, children }: { tone: keyof typeof BADGE | string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-1 text-fine font-medium ${BADGE[tone] ?? BADGE.info}`}>
      {children}
    </span>
  );
}

// ── empty state ─────────────────────────────────────────────────────────────

/** Never a bare "No data": say what this is and offer the way forward. An
 *  empty state is never inside a card — an empty card reads as broken. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid place-items-center content-center gap-2 py-16 text-center">
      <div className="text-faint">{icon}</div>
      <div className="text-heading-3">{title}</div>
      <p className="max-w-sm text-body-sm text-muted">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ── dialog ──────────────────────────────────────────────────────────────────

/** Keyboard hints live on the buttons — the cheapest way to teach the
 *  shortcuts that make a tool fast. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-1 rounded-xs bg-surface-sunken px-1 text-fine text-faint">{children}</span>
  );
}

/**
 * Modal shell. The OVERLAY is the scroll container, so a tall body starts at
 * the top and scrolls to its footer instead of clipping both ends. Escape
 * closes; focus moves into the dialog on open.
 */
export function Dialog({
  title,
  icon,
  description,
  onClose,
  children,
  footer,
}: {
  title: string;
  icon?: React.ReactNode;
  description?: string;
  onClose: () => void;
  children?: React.ReactNode;
  footer: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-foreground/40"
      onPointerDown={onClose}
      role="presentation"
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="w-full max-w-md rounded-lg bg-surface p-5 shadow-float"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <h2 className="flex items-center gap-2 text-heading-2">
            {icon}
            {title}
          </h2>
          {description && <p className="mt-1 text-body-sm text-muted">{description}</p>}
          {children}
          <div className="mt-4 flex justify-end gap-2">{footer}</div>
        </div>
      </div>
    </div>
  );
}

/** A destructive confirm NAMES the object and says what is lost. Never
 *  window.confirm — it cannot be styled, and an agent driving the browser
 *  cannot answer it. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Delete",
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      description={body}
      onClose={onClose}
      footer={
        <>
          <button className={btnGhost} onClick={onClose}>
            Cancel <Kbd>esc</Kbd>
          </button>
          <button className={btnDanger} data-autofocus onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    />
  );
}
