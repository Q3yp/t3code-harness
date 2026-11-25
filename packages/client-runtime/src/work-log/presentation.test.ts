import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  applyLiveThinkingTimer,
  createInitialLiveThinkingDisplay,
  LIVE_THINKING_BUFFER_MS,
  LIVE_THINKING_CLEAR_MS,
  LIVE_THINKING_LINE_INTERVAL_MS,
  LIVE_THINKING_MIN_DWELL_MS,
  liveThinkingBlocks,
  planLiveThinkingTimer,
  reconcileLiveThinkingDisplay,
  resolveWorkEntryToolPresentation,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
} from "./presentation.js";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it.each([
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it.each([
    "logs/app.log:12: Error: ENOENT: no such file or directory",
    "fixtures/ci.txt:3: Process exited with exit code 2",
  ])("trusts a zero exit code over failure text in the output and command: %s", (output) => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      tone: "tool",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      command: 'rg -n "ENOENT|exit code" logs fixtures',
      structuredPayload: commandItem({ output, exitCode: 0, outputIndicatesFailure: true }),
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("ignores failure phrases in reasoning text", () => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      toolLifecycleStatus: "completed",
      detail: "That exit code 2 is just from listing the deleted directory, which is expected.",
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);

    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "T3-code.t3_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Failed to clone a repository",
    );
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    const childFailure = {
      ...entry,
      label: "T3-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
  });
  it.each([
    "mcp__t3-code__preview_click",
    "mcp__t3_code__preview_click",
    "mcp__t3code__preview_click",
    "T3-code.preview_click",
    "t3-code · preview_click completed",
    "t3_code/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "t3-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "T3-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "Clicking in the preview browser",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "Clicked in the preview browser",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked in the preview browser");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click in the preview browser");
  });

  it.each([
    ["https://github.com/acme/web/pull/7", "PR #7"],
    ["https://gitlab.com/acme/web/-/merge_requests/7", "MR #7"],
  ])("names a linked change request with its host's term (%s)", (url, target) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "T3-code.link_pull_request",
        toolLifecycleStatus: "completed",
        toolData: { arguments: { url } },
      })?.displayName,
    ).toMatch(new RegExp(` ${target}$`));
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "t3-code.unknown_tool",
      "t3-code.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});

describe("liveThinkingBlocks", () => {
  const summarize = (blocks: ReturnType<typeof liveThinkingBlocks>) =>
    blocks.map((block) => ({
      key: block.key,
      heading: block.heading,
      lines: block.lines.map((line) => line.text),
    }));

  it("groups a bold heading with its paragraph and splits later headings into new blocks", () => {
    const blocks = liveThinkingBlocks(
      "**Checking settings**\n\nI need to inspect SettingsPanels.tsx. Then wire mobile.\n\n**Designing reveal**\n\nKeep the height fixed and replace blocks cleanly.",
    );
    expect(summarize(blocks)).toEqual([
      {
        key: "0",
        heading: "Checking settings",
        lines: ["I need to inspect SettingsPanels.tsx.", "Then wire mobile."],
      },
      {
        key: "1",
        heading: "Designing reveal",
        lines: ["Keep the height fixed and replace blocks cleanly."],
      },
    ]);
  });

  it("keeps the same block key and earlier lines stable while streaming into a heading block", () => {
    const step1 = liveThinkingBlocks("**Analyzing");
    const step2 = liveThinkingBlocks("**Analyzing**");
    const step3 = liveThinkingBlocks("**Analyzing**\n\nFirst sentence.");
    const step4 = liveThinkingBlocks("**Analyzing**\n\nFirst sentence. Second sentence.");

    expect(summarize(step1)).toEqual([{ key: "0", heading: "Analyzing", lines: [] }]);
    expect(summarize(step2)).toEqual([{ key: "0", heading: "Analyzing", lines: [] }]);
    expect(summarize(step3)).toEqual([
      { key: "0", heading: "Analyzing", lines: ["First sentence."] },
    ]);
    expect(summarize(step4)).toEqual([
      { key: "0", heading: "Analyzing", lines: ["First sentence.", "Second sentence."] },
    ]);
    expect(step4[0]?.lines.map((line) => line.id)).toEqual(["0:0", "0:1"]);
  });

  it("splits plain prose paragraphs and paginates long CJK or English paragraphs", () => {
    const blocks = liveThinkingBlocks(
      "第一句先检查设置面板。第二句看看移动端。第三句确认国际化。第四句检查测试。第五句准备验证。",
      { maxLinesPerBlock: 3 },
    );
    expect(summarize(blocks)).toEqual([
      {
        key: "0",
        heading: null,
        lines: ["第一句先检查设置面板。", "第二句看看移动端。", "第三句确认国际化。"],
      },
      {
        key: "1",
        heading: null,
        lines: ["第四句检查测试。", "第五句准备验证。"],
      },
    ]);
  });

  it("keeps complete sentences intact across block boundaries without orphaned fragments or streaming block jumps", () => {
    const s1 = "The import cycle appears to be the root cause.";
    const s2 =
      "`ProjectService.ts` relies on `KnownWorkspaces.ts`, which in turn depends on `MasterAssistantService.ts`, creating a circular dependency.";
    const s3Prefix = "The problematic line within `ProjectService` suggests premature evaluation";
    const s3Full = `${s3Prefix} during initialization.`;
    const s4 =
      "The lazy loading in the `Effect.gen` function provides a clue for mitigating the top-level-evaluation issue.";

    const midStream = liveThinkingBlocks(`${s1} ${s2} ${s3Prefix}`);
    const afterS3 = liveThinkingBlocks(`${s1} ${s2} ${s3Full}`);
    const full = liveThinkingBlocks(`${s1} ${s2} ${s3Full} ${s4}`);

    // While sentence 3 streams past a single visual line, it stays in block 0 instead of jumping.
    expect(midStream).toHaveLength(1);
    expect(afterS3).toHaveLength(1);
    expect(afterS3[0]?.lines.at(-1)?.text).toBe(
      "The problematic line within ProjectService suggests premature evaluation during initialization.",
    );

    // Sentence 4 opens block 1 cleanly with no orphaned trailing word from sentence 3,
    // and preserves inline code markdown for rich rendering on web.
    expect(summarize(full)).toEqual([
      {
        key: "0",
        heading: null,
        lines: [
          "The import cycle appears to be the root cause.",
          "ProjectService.ts relies on KnownWorkspaces.ts, which in turn depends on MasterAssistantService.ts, creating a circular dependency.",
          "The problematic line within ProjectService suggests premature evaluation during initialization.",
        ],
      },
      {
        key: "1",
        heading: null,
        lines: [
          "The lazy loading in the Effect.gen function provides a clue for mitigating the top-level-evaluation issue.",
        ],
      },
    ]);
    expect(full[1]?.lines[0]?.markdown).toBe(s4);
  });

  it("still paginates an unusually long unpunctuated run so it never overflows the fixed viewport", () => {
    const unpunctuated = Array.from({ length: 45 }, (_, index) => `word${index}`).join(" ");
    const blocks = liveThinkingBlocks(unpunctuated, { maxVisualWidth: 40, maxLinesPerBlock: 3 });
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((block) => block.lines.length > 0)).toBe(true);
  });

  it("reveals streamed lines one by one, dwells before clearing, and swaps to the newest block", () => {
    const initialBlocks = liveThinkingBlocks("**Checking settings**");
    let state = createInitialLiveThinkingDisplay({
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:0",
      block: initialBlocks[0],
      blockCount: initialBlocks.length,
      active: true,
      reducedMotion: false,
    });
    expect(state).toMatchObject({
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:0",
      revealedCount: 1,
      phase: "showing",
    });
    expect(
      planLiveThinkingTimer(state!, {
        latestBlockKey: "thread-1:t1:0",
        active: true,
        elapsedSinceShownMs: 0,
      }),
    ).toBeNull();

    // Same block receives two body lines: reconciles in place without clearing, then reveals line by line.
    const streamedBlocks = liveThinkingBlocks(
      "**Checking settings**\n\nFirst sentence. Second sentence.",
    );
    state = reconcileLiveThinkingDisplay(state, {
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:0",
      block: streamedBlocks[0],
      blockCount: streamedBlocks.length,
      active: true,
      reducedMotion: false,
    });
    expect(state).toMatchObject({ blockKey: "thread-1:t1:0", revealedCount: 1, phase: "showing" });
    expect(
      planLiveThinkingTimer(state!, {
        latestBlockKey: "thread-1:t1:0",
        active: true,
        elapsedSinceShownMs: 100,
      }),
    ).toEqual({ kind: "reveal-next", delayMs: LIVE_THINKING_LINE_INTERVAL_MS });

    state = applyLiveThinkingTimer(state, "reveal-next");
    expect(state?.revealedCount).toBe(2);
    state = applyLiveThinkingTimer(state, "reveal-next");
    expect(state?.revealedCount).toBe(3);

    // New block arrives early: respects remaining dwell time, then clears, then commits the latest block.
    const nextBlocks = liveThinkingBlocks(
      "**Checking settings**\n\nFirst sentence. Second sentence.\n\n**Next phase**\n\nThird sentence.",
    );
    const nextBlock = nextBlocks.at(-1)!;
    expect(
      planLiveThinkingTimer(state!, {
        latestBlockKey: "thread-1:t1:1",
        active: true,
        elapsedSinceShownMs: 250,
      }),
    ).toEqual({ kind: "begin-clear", delayMs: LIVE_THINKING_MIN_DWELL_MS - 250 });

    state = applyLiveThinkingTimer(state, "begin-clear");
    expect(state?.phase).toBe("clearing");
    expect(
      planLiveThinkingTimer(state!, {
        latestBlockKey: "thread-1:t1:1",
        active: true,
        elapsedSinceShownMs: 650,
        elapsedSinceClearingMs: 70,
      }),
    ).toEqual({ kind: "commit-cleared", delayMs: LIVE_THINKING_CLEAR_MS - 70 });

    state = applyLiveThinkingTimer(state, "commit-cleared", {
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:1",
      block: nextBlock,
      active: true,
    });
    expect(state).toMatchObject({
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:1",
      revealedCount: 1,
      phase: "showing",
    });
    expect(state?.block.heading).toBe("Next phase");

    // Committing after the thought stops streaming reveals every slot immediately.
    const settled = applyLiveThinkingTimer(state, "commit-cleared", {
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:1",
      block: nextBlock,
      active: false,
    });
    expect(settled).toMatchObject({
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:1",
      revealedCount: 2,
      phase: "showing",
    });

    // Reduced motion swaps immediately with every slot revealed.
    const reduced = reconcileLiveThinkingDisplay(state, {
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:1",
      block: nextBlock,
      blockCount: nextBlocks.length,
      active: true,
      reducedMotion: true,
    });
    expect(reduced).toMatchObject({
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:1",
      revealedCount: 2,
      phase: "showing",
    });
  });

  it("resets immediately when the thread or thought scope changes on a recycled row", () => {
    const [threadABlock] = liveThinkingBlocks("Thread A thought.");
    const [threadBBlock] = liveThinkingBlocks("Thread B thought. Second sentence.");

    const threadAState = createInitialLiveThinkingDisplay({
      scopeKey: "thread-a:thought-1",
      blockKey: "thread-a:thought-1:0",
      block: threadABlock,
      blockCount: 1,
      active: true,
      reducedMotion: false,
    })!;

    // Switching threads or reasoning items must never dwell on or leak the prior scope's text.
    const switched = reconcileLiveThinkingDisplay(threadAState, {
      scopeKey: "thread-b:thought-1",
      blockKey: "thread-b:thought-1:0",
      block: threadBBlock,
      blockCount: 1,
      active: true,
      reducedMotion: false,
    });
    expect(switched).toMatchObject({
      scopeKey: "thread-b:thought-1",
      blockKey: "thread-b:thought-1:0",
      phase: "showing",
      revealedCount: 1,
    });
    expect(switched?.block.lines[0]?.text).toBe("Thread B thought.");

    // Same when the prior scope was mid-clear.
    const clearingA = applyLiveThinkingTimer(threadAState, "begin-clear");
    const switchedFromClearing = reconcileLiveThinkingDisplay(clearingA, {
      scopeKey: "thread-b:thought-2",
      blockKey: "thread-b:thought-2:0",
      block: threadBBlock,
      blockCount: 1,
      active: false,
      reducedMotion: false,
    });
    expect(switchedFromClearing).toMatchObject({
      scopeKey: "thread-b:thought-2",
      blockKey: "thread-b:thought-2:0",
      phase: "showing",
      revealedCount: 2,
    });
  });

  it("buffers a tiny opening fragment of an incoming block briefly before clearing the current block", () => {
    const [firstBlock] = liveThinkingBlocks("First paragraph done.");
    const state = createInitialLiveThinkingDisplay({
      scopeKey: "thread-1:t1",
      blockKey: "thread-1:t1:0",
      block: firstBlock,
      blockCount: 1,
      active: true,
      reducedMotion: false,
    })!;

    const [, tinyIncoming] = liveThinkingBlocks("First paragraph done.\n\nThe lazy");
    // Even after the current block finished dwelling, wait up to LIVE_THINKING_BUFFER_MS for a tiny fragment.
    expect(
      planLiveThinkingTimer(state, {
        latestBlockKey: "thread-1:t1:1",
        latestBlock: tinyIncoming,
        active: true,
        elapsedSinceShownMs: LIVE_THINKING_MIN_DWELL_MS + 100,
        elapsedSinceLatestBlockMs: 50,
      }),
    ).toEqual({ kind: "begin-clear", delayMs: LIVE_THINKING_BUFFER_MS - 50 });

    // Once the buffer expires or the stream stops, clear immediately so nothing gets stuck.
    expect(
      planLiveThinkingTimer(state, {
        latestBlockKey: "thread-1:t1:1",
        latestBlock: tinyIncoming,
        active: true,
        elapsedSinceShownMs: LIVE_THINKING_MIN_DWELL_MS + 400,
        elapsedSinceLatestBlockMs: LIVE_THINKING_BUFFER_MS,
      }),
    ).toEqual({ kind: "begin-clear", delayMs: 0 });
    expect(
      planLiveThinkingTimer(state, {
        latestBlockKey: "thread-1:t1:1",
        latestBlock: tinyIncoming,
        active: false,
        elapsedSinceShownMs: 0,
        elapsedSinceLatestBlockMs: 0,
      }),
    ).toEqual({ kind: "begin-clear", delayMs: 0 });

    // As soon as a full sentence arrives, no extra buffer wait is needed.
    const [, readyIncoming] = liveThinkingBlocks(
      "First paragraph done.\n\nThe lazy loading works.",
    );
    expect(
      planLiveThinkingTimer(state, {
        latestBlockKey: "thread-1:t1:1",
        latestBlock: readyIncoming,
        active: true,
        elapsedSinceShownMs: LIVE_THINKING_MIN_DWELL_MS + 100,
        elapsedSinceLatestBlockMs: 0,
      }),
    ).toEqual({ kind: "begin-clear", delayMs: 0 });
  });
});
