import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertCircle, LoaderCircle, X } from "lucide-react";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <span className="loading" role="status">
      <LoaderCircle size={18} className="spin" />
      {label}
    </span>
  );
}
export function ErrorNotice({
  message,
  clear,
}: {
  message: string;
  clear?: () => void;
}) {
  if (!message) return null;
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {clear && (
        <button
          className="icon-button"
          onClick={clear}
          aria-label="Dismiss error"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
export function Modal({
  title,
  close,
  children,
  wide = false,
  fullScreen = false,
  showCloseButton = true,
  closeLabel = "Close dialog",
  headerAside,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  fullScreen?: boolean;
  showCloseButton?: boolean;
  closeLabel?: string;
  headerAside?: ReactNode;
}) {
  const id = useId();
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const modal = document.getElementById(id);
    const focusable = () =>
      Array.from(
        modal?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
        ) || [],
      ).filter(
        (element) =>
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden",
      );
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      if (!items.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        items[event.shiftKey ? items.length - 1 : 0].focus();
      } else if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === items[items.length - 1]
      ) {
        event.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus();
    };
  }, [id]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <section
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={`modal ${wide ? "modal-wide" : ""} ${fullScreen ? "modal-fullscreen" : ""}`}
      >
        <header className="modal-header">
          <h2 id={`${id}-title`}>{title}</h2>
          {headerAside}
          {showCloseButton && (
            <button
              className="icon-button"
              onClick={() => closeRef.current()}
              aria-label={closeLabel}
            >
              <X size={20} />
            </button>
          )}
        </header>
        {children}
      </section>
    </div>
  );
}
export function Avatar({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  return (
    <span className={`avatar ${small ? "avatar-small" : ""}`} title={name}>
      {name
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase() || "?"}
    </span>
  );
}
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <img className="brand-mark" src="/kangentix-logo.svg" alt="" aria-hidden="true" />
      <span>
        Kangentix
      </span>
    </div>
  );
}
