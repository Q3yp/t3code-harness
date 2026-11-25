import {
  applyLiveThinkingTimer,
  createInitialLiveThinkingDisplay,
  isLiveThinkingBlockReady,
  liveThinkingBlocks,
  liveThinkingBlockSlotCount,
  planLiveThinkingTimer,
  reconcileLiveThinkingDisplay,
} from "@t3tools/client-runtime/work-log/presentation";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

const INLINE_MARKDOWN_TOKEN = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/g;

function normalizeStreamingInlineMarkdown(source: string): string {
  let result = source.replace(/(^|\s)(?:\*{1,2}|~~)$/, "$1");
  const backticks = result.match(/`/g)?.length ?? 0;
  if (backticks % 2 === 1) {
    result = result.endsWith("`") ? result.slice(0, -1) : `${result}\``;
  }
  return result;
}

/**
 * Renders inline thought formatting (`code`, **bold**, *italic*, ~~strike~~) without
 * interactive links or buttons so it stays valid inside the live work row's disclosure button
 * while matching expanded Thought markdown styling via `.chat-markdown`.
 */
function renderInlineThoughtMarkdown(source: string): ReactNode {
  const normalized = normalizeStreamingInlineMarkdown(source);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;
  INLINE_MARKDOWN_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_MARKDOWN_TOKEN.exec(normalized)) !== null) {
    if (match.index > cursor) {
      nodes.push(normalized.slice(cursor, match.index));
    }
    const key = `t${tokenIndex++}`;
    if (match[1] !== undefined) {
      nodes.push(<code key={key}>{match[1]}</code>);
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={key}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(<del key={key}>{match[3]}</del>);
    } else if (match[4] !== undefined) {
      nodes.push(<em key={key}>{match[4]}</em>);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < normalized.length) {
    nodes.push(normalized.slice(cursor));
  }
  return nodes;
}

/**
 * Fixed-height live thinking preview that replaces blocks in place without scrolling
 * or changing layout height, then reveals each block's lines progressively at a
 * reading-friendly pace.
 */
export function LiveThinkingStream({
  scopeKey,
  text,
  active,
}: {
  scopeKey: string;
  text: string;
  active: boolean;
}) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const blocks = liveThinkingBlocks(text);
  const latestBlock = blocks.at(-1);
  const latestBlockKey = latestBlock ? `${scopeKey}:${latestBlock.key}` : "";

  const containerRef = useRef<HTMLDivElement>(null);
  const shownAtRef = useRef<{ blockKey: string; time: number } | null>(null);
  const latestBlockSeenRef = useRef<{ blockKey: string; time: number } | null>(null);
  const clearingStartedAtRef = useRef<{ blockKey: string; time: number } | null>(null);
  const [visible, setVisible] = useState(true);

  const targetInput = {
    scopeKey,
    blockKey: latestBlockKey,
    block: latestBlock,
    blockCount: blocks.length,
    active,
    reducedMotion: prefersReducedMotion,
  };

  const [display, setDisplay] = useState(() => createInitialLiveThinkingDisplay(targetInput));

  const readLatestTarget = useEffectEvent(() => ({
    scopeKey,
    blockKey: latestBlockKey,
    block: latestBlock,
    active,
  }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks offscreen/background visibility to pause timers when the live row is not visible
  useEffect(() => {
    const element = containerRef.current;
    let intersecting = true;
    const sync = () => {
      setVisible(intersecting && document.visibilityState === "visible");
    };
    const observer =
      element && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            const entry = entries.at(-1);
            if (!entry) return;
            intersecting = entry.isIntersecting;
            sync();
          })
        : null;
    if (element && observer) observer.observe(element);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const reconciled = reconcileLiveThinkingDisplay(display, targetInput);
  if (reconciled !== display) {
    setDisplay(reconciled);
  }

  const totalSlots = reconciled ? liveThinkingBlockSlotCount(reconciled.block) : 0;
  const displayScopeKey = reconciled?.scopeKey ?? "";
  const displayBlockKey = reconciled?.blockKey ?? "";
  const displayPhase = reconciled?.phase ?? null;
  const displayRevealedCount = reconciled?.revealedCount ?? 0;
  const hasUnrevealedSlots = reconciled !== null && reconciled.revealedCount < totalSlots;
  const pendingBlockKey =
    reconciled !== null && reconciled.phase === "showing" && reconciled.blockKey !== latestBlockKey
      ? latestBlockKey
      : "";
  const pendingBlockReady =
    pendingBlockKey !== "" && latestBlock !== undefined
      ? isLiveThinkingBlockReady(latestBlock)
      : true;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives timed line-by-line progressive reveal and block replacement
  useEffect(() => {
    if (!displayScopeKey || !displayBlockKey || !displayPhase || prefersReducedMotion || !visible) {
      return;
    }
    const now = Date.now();
    if (shownAtRef.current?.blockKey !== displayBlockKey) {
      shownAtRef.current = { blockKey: displayBlockKey, time: now };
    }
    if (pendingBlockKey) {
      if (latestBlockSeenRef.current?.blockKey !== pendingBlockKey) {
        latestBlockSeenRef.current = { blockKey: pendingBlockKey, time: now };
      }
    } else {
      latestBlockSeenRef.current = null;
    }
    if (displayPhase === "clearing") {
      if (clearingStartedAtRef.current?.blockKey !== displayBlockKey) {
        clearingStartedAtRef.current = { blockKey: displayBlockKey, time: now };
      }
    } else {
      clearingStartedAtRef.current = null;
    }
    const plan = planLiveThinkingTimer(
      {
        blockKey: displayBlockKey,
        phase: displayPhase,
        hasUnrevealedSlots,
      },
      {
        latestBlockKey: pendingBlockKey || displayBlockKey,
        latestBlockReady: pendingBlockReady,
        active,
        elapsedSinceShownMs: now - shownAtRef.current.time,
        elapsedSinceLatestBlockMs: latestBlockSeenRef.current
          ? now - latestBlockSeenRef.current.time
          : 0,
        elapsedSinceClearingMs: clearingStartedAtRef.current
          ? now - clearingStartedAtRef.current.time
          : 0,
      },
    );
    if (!plan) return;
    const timer = window.setTimeout(() => {
      if (plan.kind === "commit-cleared") {
        const target = readLatestTarget();
        if (target.scopeKey !== displayScopeKey) return;
        shownAtRef.current = target.block ? { blockKey: target.blockKey, time: Date.now() } : null;
        clearingStartedAtRef.current = null;
        setDisplay((current) =>
          current && current.scopeKey !== displayScopeKey
            ? current
            : applyLiveThinkingTimer(current, plan.kind, target),
        );
        return;
      }
      if (plan.kind === "begin-clear") {
        clearingStartedAtRef.current = { blockKey: displayBlockKey, time: Date.now() };
        setDisplay((current) =>
          current && current.scopeKey === displayScopeKey
            ? applyLiveThinkingTimer(current, plan.kind)
            : current,
        );
        return;
      }
      setDisplay((current) =>
        current &&
        current.scopeKey === displayScopeKey &&
        current.revealedCount === displayRevealedCount
          ? applyLiveThinkingTimer(current, plan.kind)
          : current,
      );
    }, plan.delayMs);
    return () => window.clearTimeout(timer);
  }, [
    displayScopeKey,
    displayBlockKey,
    displayPhase,
    displayRevealedCount,
    hasUnrevealedSlots,
    pendingBlockKey,
    pendingBlockReady,
    active,
    prefersReducedMotion,
    visible,
  ]);

  if (!reconciled) return null;

  const hasHeading = reconciled.block.heading !== null;
  const showHeading = hasHeading && reconciled.revealedCount > 0;
  const visibleBodyLineCount = Math.max(0, reconciled.revealedCount - (hasHeading ? 1 : 0));
  const visibleBodyLines = reconciled.block.lines.slice(0, visibleBodyLineCount);
  const isSettled =
    !active &&
    reconciled.phase === "showing" &&
    reconciled.blockKey === latestBlockKey &&
    reconciled.revealedCount >= totalSlots;

  return (
    <div
      ref={containerRef}
      data-live-thinking-stream
      className={cn(
        "chat-markdown relative w-full overflow-hidden text-sm leading-relaxed text-foreground",
        isSettled
          ? "max-h-[6.25rem]"
          : "h-[6.25rem] [mask-image:linear-gradient(to_bottom,black_88%,transparent)]",
      )}
    >
      <div
        key={reconciled.blockKey}
        className={cn(
          "flex min-w-0 flex-col gap-0.5",
          !prefersReducedMotion && "transition-opacity duration-150 ease-out",
          reconciled.phase === "clearing" ? "opacity-0" : "opacity-100",
        )}
      >
        {showHeading ? (
          <span
            key={`${reconciled.blockKey}:heading`}
            className="live-thinking-line-in block truncate font-bold text-foreground"
          >
            {reconciled.block.heading}
          </span>
        ) : null}
        {visibleBodyLines.map((line) => (
          <span
            key={`${reconciled.blockKey}:${line.id}`}
            className="live-thinking-line-in block text-foreground"
          >
            {renderInlineThoughtMarkdown(line.markdown)}
          </span>
        ))}
      </div>
    </div>
  );
}
