import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { AgentView, PostView } from "../../shared/runstate.ts";
import type { ViewProps } from "../contract.ts";
import { relatedToSelection } from "../useRun.ts";
import { AgentDot, AgentName, agentColor } from "./primitives.tsx";
import "./Board.css";

export interface BoardProps extends ViewProps {
  /** Following live: keep the newest post in view. */
  following: boolean;
  /** The authors whose posts are shown; empty shows every author. */
  authors: readonly string[];
  setAuthors(authors: readonly string[]): void;
}

const STICK_THRESHOLD_PX = 24;

/**
 * Posts up to the selected tick in commit order, with read receipts, author filters, and highlights for
 * whatever the selection relates to.
 */
export function Board({ state, selection, select, following, authors: authorFilter, setAuthors }: BoardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const related = useMemo(() => relatedToSelection(selection, state), [selection, state]);
  // Agent indexes never change within a run, so this map (and the memoized cards) survive scrubbing.
  const agentIndexes = useMemo(
    () => new Map(state.started.agents.map((agent) => [agent.name, agent.index])),
    [state.started],
  );
  const postCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const post of state.posts) counts.set(post.author, (counts.get(post.author) ?? 0) + 1);
    return counts;
  }, [state.posts]);
  // Names that aren't agents are ignored, and filtering by every author is no filter.
  const authors = useMemo(() => {
    const known = new Set(authorFilter.filter((name) => agentIndexes.has(name)));
    return known.size === agentIndexes.size ? new Set<string>() : known;
  }, [authorFilter, agentIndexes]);
  const visible = authors.size === 0 ? state.posts : state.posts.filter((post) => authors.has(post.author));

  // Kept in agent order, so the URL doesn't depend on the order the chips were clicked in.
  const toggleAuthor = (name: string) => {
    const next = new Set(authors);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    const names = state.agents.map((agent) => agent.info.name).filter((agent) => next.has(agent));
    setAuthors(names.length === state.agents.length ? [] : names);
  };

  // Stay pinned to the newest post while following live, or while the reader is already at the bottom.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && (following || atBottom.current)) body.scrollTop = body.scrollHeight;
  }, [visible.length, following]);

  // Bring the selected post, or the first post the selected step touched, into view.
  const focusPostId = useMemo(() => {
    for (const post of visible) if (related.posts.has(post.id)) return post.id;
    return null;
  }, [visible, related]);
  useLayoutEffect(() => {
    if (focusPostId === null || following) return;
    bodyRef.current
      ?.querySelector<HTMLElement>(`[data-post-id="${focusPostId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusPostId, selection, following]);

  const onScroll = () => {
    const body = bodyRef.current;
    if (body) atBottom.current = body.scrollHeight - body.scrollTop - body.clientHeight < STICK_THRESHOLD_PX;
  };

  const filtered = authors.size > 0;

  return (
    <div className="board">
      <div className="panel-header board-header">
        <div className="board-title-row">
          <span className="panel-title">Board</span>
          <span className="panel-count">
            {filtered ? `${visible.length} of ${state.posts.length}` : state.posts.length} post
            {state.posts.length === 1 && !filtered ? "" : "s"} · step {state.tick}
          </span>
        </div>
        {state.agents.length > 1 && (
          <div className="board-chips" role="group" aria-label="Filter posts by author">
            <button
              type="button"
              className="board-chip"
              aria-pressed={!filtered}
              onClick={() => setAuthors([])}
            >
              All
            </button>
            {state.agents.map((agent) => (
              <button
                key={agent.info.name}
                type="button"
                className="board-chip"
                aria-pressed={authors.has(agent.info.name)}
                onClick={() => toggleAuthor(agent.info.name)}
              >
                <AgentDot index={agent.info.index} />
                {agent.info.name}
                <span className="board-chip-count num">{postCounts.get(agent.info.name) ?? 0}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="panel-body board-body" ref={bodyRef} onScroll={onScroll}>
        {visible.length === 0 ? (
          <div className="state-message">
            {filtered ? "No posts by these authors yet." : `No posts yet at step ${state.tick}.`}
          </div>
        ) : (
          <ol className="board-list">
            {visible.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                isNew={post.tick === state.tick}
                unseen={unseenBy(post, state.agents)}
                agentIndexes={agentIndexes}
                highlight={related.posts.get(post.id) ?? null}
                select={select}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** "Wren, Otter (done)": the other agents the post hasn't been delivered to yet, with their status when final. */
function unseenBy(post: PostView, agents: readonly AgentView[]): string {
  const seen = new Set(post.received_by.map((receipt) => receipt.agent));
  return agents
    .filter((agent) => agent.info.name !== post.author && !seen.has(agent.info.name))
    .map((agent) =>
      agent.status === "done" || agent.status === "stopped" ? `${agent.info.name} (${agent.status})` : agent.info.name,
    )
    .join(", ");
}

interface PostCardProps {
  post: PostView;
  /** Posted at the selected tick. */
  isNew: boolean;
  unseen: string;
  agentIndexes: ReadonlyMap<string, number>;
  highlight: "selected" | "created" | "received" | null;
  select: ViewProps["select"];
}

/**
 * Every scrub derives new post records, so cards are memoized on what they show. A post's receipts and
 * replies only grow along the log, so their counts identify them.
 */
const PostCard = memo(
  function PostCard({ post, isNew, unseen, agentIndexes, highlight, select }: PostCardProps) {
    const authorIndex = agentIndexes.get(post.author) ?? 0;

    const classes = ["post"];
    if (highlight) classes.push(`post-${highlight}`);

    return (
      <li
        className={classes.join(" ")}
        data-post-id={post.id}
        style={{ borderLeftColor: agentColor(authorIndex) }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, a")) return;
          select({ kind: "post", id: post.id });
        }}
      >
        <div className="post-head">
          <AgentName name={post.author} index={authorIndex} />
          <button
            type="button"
            className="link-btn mono post-id"
            onClick={() => select({ kind: "post", id: post.id })}
            aria-label={`Select post #${post.id}`}
          >
            #{post.id}
          </button>
          <button
            type="button"
            className="link-btn post-step"
            onClick={() => select({ kind: "step", agent: post.author, tick: post.tick })}
            title={`Select ${post.author}'s step ${post.tick}`}
          >
            step {post.tick}
          </button>
          {post.reply_to !== null && (
            <button type="button" className="link-btn post-reply" onClick={() => select({ kind: "post", id: post.reply_to! })}>
              reply to #{post.reply_to}
            </button>
          )}
          {highlight === "created" && <span className="post-tag">written by the selected step</span>}
          {highlight === "received" && <span className="post-tag">received by the selected step</span>}
          {isNew && (
            <span className="post-new" title="Posted at the selected step">
              new
            </span>
          )}
        </div>

        <div className="post-text">{post.text}</div>

        <div className="post-foot">
          {post.received_by.length > 0 ? (
            <span className="post-seen">
              <span>seen by</span>
              {post.received_by.map((receipt) => (
                <span key={receipt.agent} className="post-receipt" title={`${receipt.agent} received it at step ${receipt.tick}`}>
                  <AgentDot index={agentIndexes.get(receipt.agent) ?? 0} />
                  {receipt.agent}
                  <span className="num post-receipt-step">
                    <span className="visually-hidden">at step</span> {receipt.tick}
                  </span>
                </span>
              ))}
            </span>
          ) : null}
          {unseen !== "" && <span className="post-unseen">not yet seen by {unseen}</span>}
          {post.replies.length > 0 && (
            <span className="post-replies">
              {post.replies.length} {post.replies.length === 1 ? "reply" : "replies"}:{" "}
              {post.replies.map((id) => (
                <button key={id} type="button" className="link-btn mono" onClick={() => select({ kind: "post", id })}>
                  #{id}
                </button>
              ))}
            </span>
          )}
        </div>
      </li>
    );
  },
  (a, b) =>
    a.post.id === b.post.id &&
    a.post.received_by.length === b.post.received_by.length &&
    a.post.replies.length === b.post.replies.length &&
    a.isNew === b.isNew &&
    a.unseen === b.unseen &&
    a.agentIndexes === b.agentIndexes &&
    a.highlight === b.highlight &&
    a.select === b.select,
);
