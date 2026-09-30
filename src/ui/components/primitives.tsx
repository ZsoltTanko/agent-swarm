import type { ReactNode } from "react";
import "./primitives.css";

/** CSS color for an agent, by AgentInfo.index (see tokens.css). */
export function agentColor(index: number): string {
  return `var(--agent-${index % 12})`;
}

/** CSS color for text set on agentColor(index). */
export function agentInk(index: number): string {
  return `var(--agent-${index % 12}-ink)`;
}

export function AgentDot({ index, size = 8, title }: { index: number; size?: number; title?: string }) {
  return (
    <span
      className="agent-dot"
      title={title}
      style={{ width: size, height: size, background: agentColor(index) }}
    />
  );
}

export function AgentName({ name, index }: { name: string; index: number }) {
  return (
    <span className="agent-name">
      <AgentDot index={index} />
      {name}
    </span>
  );
}

export type PillTone = "neutral" | "accent" | "success" | "warning" | "danger";

export function Pill({ tone = "neutral", children, title }: { tone?: PillTone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}
