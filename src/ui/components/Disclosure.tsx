import { useState, type ReactNode } from "react";
import { IconChevronDown, IconChevronRight } from "../icons.tsx";
import "./Disclosure.css";

export interface DisclosureProps {
  label: ReactNode;
  meta?: ReactNode;
  /** A one-line preview shown while collapsed. */
  preview?: string;
  defaultOpen?: boolean;
  className?: string;
  /**
   * The body, rendered only while open. A function also defers building it, for bodies that are
   * expensive to compute (a rebuilt request context, a large JSON tree).
   */
  children: ReactNode | (() => ReactNode);
}

/** A collapsible section: a chevron button with a label, optional meta text, and a preview while collapsed. */
export function Disclosure({ label, meta, preview, defaultOpen = false, className, children }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className ? `disclosure ${className}` : "disclosure"}>
      <button type="button" className="disclosure-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <span className="disclosure-label">{label}</span>
        {meta !== undefined && <span className="disclosure-meta">{meta}</span>}
        {!open && preview && <span className="disclosure-preview">{preview}</span>}
      </button>
      {open && <div className="disclosure-body">{typeof children === "function" ? children() : children}</div>}
    </div>
  );
}
