import type { ReactNode } from "react";

/**
 * Small stroke icons on a 16×16 grid, drawn in currentColor. Without a title an icon is decorative
 * (aria-hidden); with one it is announced as an image with that name.
 */
export interface IconProps {
  size?: number;
  title?: string;
  className?: string;
}

function Svg({ size = 14, title, className, children }: IconProps & { children: ReactNode }) {
  const labelled = title !== undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon ${className}` : "icon"}
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {labelled && <title>{title}</title>}
      {children}
    </svg>
  );
}

/** Read the board: an inbox tray. */
export function IconBoard(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 9.5h3.2l1 1.8h2.6l1-1.8h3.2" />
      <path d="M4.2 3h7.6l1.7 6.5V13H2.5V9.5z" />
    </Svg>
  );
}

/** Post a message: a speech bubble. */
export function IconPost(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 2.8h10a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H7.2L4.2 13.8v-2.6H3a1 1 0 0 1-1-1V3.8a1 1 0 0 1 1-1z" />
    </Svg>
  );
}

/** Open a document: a page with a folded corner. */
export function IconDoc(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
      <path d="M9 1.8V5.2h3.5" />
    </Svg>
  );
}

/** Read the deliverable: an open book. */
export function IconDeliverable(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 4.2C6.6 3.2 4.6 2.7 2 2.7v9.6c2.6 0 4.6.5 6 1.5 1.4-1 3.4-1.5 6-1.5V2.7c-2.6 0-4.6.5-6 1.5z" />
      <path d="M8 4.2v9.6" />
    </Svg>
  );
}

/** Write the deliverable: a pencil. */
export function IconWrite(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.6 2.4l3 3-8 8-3.6.6.6-3.6z" />
      <path d="M9.1 3.9l3 3" />
    </Svg>
  );
}

/** List documents: three lines. */
export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      <path d="M2.5 4h.1M2.5 8h.1M2.5 12h.1" />
    </Svg>
  );
}

export function IconSleep(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.2 9.8A5.6 5.6 0 1 1 6.2 2.8a4.5 4.5 0 0 0 7 7z" />
    </Svg>
  );
}

export function IconWake(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </Svg>
  );
}

export function IconDone(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.4 8.2l1.8 1.8 3.4-3.7" />
    </Svg>
  );
}

export function IconStop(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <rect x="5.8" y="5.8" width="4.4" height="4.4" rx="0.5" />
    </Svg>
  );
}

export function IconError(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6 6l4 4M10 6l-4 4" />
    </Svg>
  );
}

/** A warning, also used for a truncated response. */
export function IconWarning(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.2l6.2 11H1.8z" />
      <path d="M8 6.4v3.1M8 11.4v.1" />
    </Svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 3.2v9.6l7.6-4.8z" fill="currentColor" />
    </Svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth={2} />
    </Svg>
  );
}

export function IconStepBack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 3.5v9" />
      <path d="M12 3.5v9L6.5 8z" fill="currentColor" />
    </Svg>
  );
}

export function IconStepForward(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5v9" />
      <path d="M4 3.5v9L9.5 8z" fill="currentColor" />
    </Svg>
  );
}

/** Live: a dot with broadcast arcs. */
export function IconLive(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      <path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.1 3.1a7 7 0 0 0 0 9.8M12.9 3.1a7 7 0 0 1 0 9.8" />
    </Svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4l3.6 3.6" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5l4.5 4.5L6 12.5" />
    </Svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 6l4.5 4.5L12.5 6" />
    </Svg>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.5 9v3.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1H7" />
      <path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5" />
    </Svg>
  );
}

export function IconBack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8H3M7 4L3 8l4 4" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}
