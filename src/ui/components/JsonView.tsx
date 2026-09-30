import { useState } from "react";
import { IconChevronDown, IconChevronRight } from "../icons.tsx";
import "./JsonView.css";

export interface JsonViewProps {
  value: unknown;
  /** Shown as the root's name. */
  label?: string;
  /** Levels expanded at first (the root is level 0). */
  defaultDepth?: number;
}

const STRING_PREVIEW_CHARS = 240;

/**
 * A collapsible JSON tree. Children render only once their parent is expanded, and long strings are
 * cut short until expanded, so large requests (whole contexts) stay responsive.
 */
export function JsonView({ value, label, defaultDepth = 1 }: JsonViewProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(JSON.stringify(value, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };
  return (
    <div className="json-view">
      <button type="button" className="link-btn json-copy" onClick={copy}>
        {copied ? "Copied" : "Copy JSON"}
      </button>
      <JsonNode name={label ?? null} value={value} depth={0} defaultDepth={defaultDepth} />
    </div>
  );
}

function JsonNode({
  name,
  value,
  depth,
  defaultDepth,
}: {
  name: string | null;
  value: unknown;
  depth: number;
  defaultDepth: number;
}) {
  const [open, setOpen] = useState(depth < defaultDepth);

  if (value === null || typeof value !== "object") {
    return (
      <div className="json-row">
        {name !== null && <span className="json-key">{name}: </span>}
        <JsonScalar value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`;
  const hint = isArray ? null : previewField(value as Record<string, unknown>);

  return (
    <div className="json-node">
      <button
        type="button"
        className="json-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={entries.length === 0}
      >
        {entries.length > 0 ? (
          open ? (
            <IconChevronDown size={11} />
          ) : (
            <IconChevronRight size={11} />
          )
        ) : (
          <span className="json-spacer" />
        )}
        {name !== null && <span className="json-key">{name}</span>}
        <span className="json-summary">{summary}</span>
        {hint && !open && <span className="json-hint">{hint}</span>}
      </button>
      {open && entries.length > 0 && (
        <div className="json-children">
          {entries.map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} depth={depth + 1} defaultDepth={defaultDepth} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A collapsed object's identifying field, such as a message's role or a tool call's name. */
function previewField(value: Record<string, unknown>): string | null {
  for (const key of ["role", "type", "name", "id"]) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) return `${key}: ${field.length > 40 ? `${field.slice(0, 40)}…` : field}`;
  }
  return null;
}

function JsonScalar({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  if (typeof value === "string") {
    const long = value.length > STRING_PREVIEW_CHARS || value.includes("\n");
    if (!long) return <span className="json-string">"{value}"</span>;
    if (!expanded) {
      const preview = value.slice(0, STRING_PREVIEW_CHARS).split("\n")[0] ?? "";
      return (
        <span className="json-string">
          "{preview}…"{" "}
          <button type="button" className="link-btn json-more" onClick={() => setExpanded(true)}>
            {value.length.toLocaleString()} chars
          </button>
        </span>
      );
    }
    return (
      <span className="json-string json-string-full">
        <button type="button" className="link-btn json-more" onClick={() => setExpanded(false)}>
          Collapse
        </button>
        <span className="json-string-text">{value}</span>
      </span>
    );
  }
  if (value === null) return <span className="json-literal">null</span>;
  if (value === undefined) return <span className="json-literal">undefined</span>;
  return <span className="json-literal">{String(value)}</span>;
}
