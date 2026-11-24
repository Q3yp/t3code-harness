import {
  applyLiveThinkingTimer,
  createInitialLiveThinkingDisplay,
  liveThinkingBlocks,
  planLiveThinkingTimer,
  reconcileLiveThinkingDisplay,
} from "@t3tools/client-runtime/work-log/presentation";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

/**
 * Fixed-height live thinking preview that replaces blocks in place without scrolling
 * or changing layout height, then reveals each block's lines progressively at a
 * reading-friendly pace.
 */
export function LiveThinkingStream({
  thoughtId,
  text,
  active,
}: {
  thoughtId: string;
  text: string;
  active: boolean;
}) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const blocks = liveThinkingBlocks(text);
  const latestBlock = blocks.at(-1);
  const latestBlockKey = latestBlock ? `${thoughtId}:${latestBlock.key}` : "";

  const containerRef = useRef<HTMLDivElement>(null);
  const shownAtRef = useRef<{ blockKey: string; time: number } | null>(null);
  const [visible, setVisible] = useState(true);

  const targetInput = {
    blockKey: latestBlockKey,
    block: latestBlock,
    blockCount: blocks.length,
    active,
    reducedMotion: prefersReducedMotion,
  };

  const [display, setDisplay] = useState(() => createInitialLiveThinkingDisplay(targetInput));

  const readLatestTarget = useEffectEvent(() => ({
    blockKey: latestBlockKey,
    block: latestBlock,
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives timed line-by-line progressive reveal and block replacement
  useEffect(() => {
    if (!reconciled || !latestBlock || prefersReducedMotion || !visible) return;
    if (shownAtRef.current?.blockKey !== reconciled.blockKey) {
      shownAtRef.current = { blockKey: reconciled.blockKey, time: Date.now() };
    }
    const plan = planLiveThinkingTimer(reconciled, {
      latestBlockKey,
      active,
      elapsedSinceShownMs: Date.now() - shownAtRef.current.time,
    });
    if (!plan) return;
    const timer = window.setTimeout(() => {
      if (plan.kind === "commit-cleared") {
        const target = readLatestTarget();
        shownAtRef.current = target.block ? { blockKey: target.blockKey, time: Date.now() } : null;
        setDisplay((current) => applyLiveThinkingTimer(current, plan.kind, target));
        return;
      }
      setDisplay((current) => applyLiveThinkingTimer(current, plan.kind));
    }, plan.delayMs);
    return () => window.clearTimeout(timer);
  }, [reconciled, latestBlock, latestBlockKey, active, prefersReducedMotion, visible]);

  if (!reconciled) return null;

  const hasHeading = reconciled.block.heading !== null;
  const showHeading = hasHeading && reconciled.revealedCount > 0;
  const visibleBodyLineCount = Math.max(0, reconciled.revealedCount - (hasHeading ? 1 : 0));
  const visibleBodyLines = reconciled.block.lines.slice(0, visibleBodyLineCount);

  return (
    <div
      ref={containerRef}
      data-live-thinking-stream
      className="relative h-[6.5rem] w-full overflow-hidden text-sm leading-relaxed [mask-image:linear-gradient(to_bottom,black_84%,transparent)]"
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
            className="live-thinking-line-in block truncate font-medium text-foreground/85"
          >
            {reconciled.block.heading}
          </span>
        ) : null}
        {visibleBodyLines.map((line) => (
          <span
            key={`${reconciled.blockKey}:${line.id}`}
            className="live-thinking-line-in block text-secondary-label"
          >
            {line.text}
          </span>
        ))}
      </div>
    </div>
  );
}
