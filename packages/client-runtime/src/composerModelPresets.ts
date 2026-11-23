import type { ModelPreset } from "@t3tools/contracts/settings";

export type AtMentionCategory = "all" | "preset" | "model" | "thread" | "environment" | "path";

export interface ParsedAtMentionQuery {
  readonly category: AtMentionCategory;
  readonly query: string;
  readonly prefix: string | null;
}

const AT_CATEGORY_BY_PREFIX: Readonly<Record<string, Exclude<AtMentionCategory, "all">>> = {
  p: "preset",
  preset: "preset",
  presets: "preset",
  m: "model",
  model: "model",
  models: "model",
  t: "thread",
  thread: "thread",
  threads: "thread",
  e: "environment",
  env: "environment",
  machine: "environment",
  machines: "environment",
  f: "path",
  file: "path",
  files: "path",
  path: "path",
};

/**
 * Splits quick-index prefixes like `@p:opus`, `@m:claude`, `@t:auth`, `@f:ws.ts`, `@e:mac`
 * without disturbing model search shortcuts like `@gpt:traex`.
 */
export function parseAtMentionQuery(rawQuery: string): ParsedAtMentionQuery {
  const colonIndex = rawQuery.indexOf(":");
  if (colonIndex > 0) {
    const candidate = rawQuery.slice(0, colonIndex).toLowerCase();
    const category = AT_CATEGORY_BY_PREFIX[candidate];
    if (category !== undefined) {
      return {
        category,
        query: rawQuery.slice(colonIndex + 1),
        prefix: rawQuery.slice(0, colonIndex + 1),
      };
    }
  }
  return { category: "all", query: rawQuery, prefix: null };
}

export function formatModelSwitchPresetToken(name: string): string {
  return `@${name}`;
}

export function formatSubagentPresetToken(name: string): string {
  return `^${name}`;
}

export function findModelPresetByName(
  presets: ReadonlyArray<ModelPreset>,
  name: string,
): ModelPreset | undefined {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  return presets.find((preset) => preset.name.toLowerCase() === needle);
}

function buildKnownModelPresetNameSet(presets: ReadonlyArray<ModelPreset>): ReadonlySet<string> {
  return new Set(presets.map((preset) => preset.name.toLowerCase()));
}

export function rankComposerModelPresets<T>(
  presets: ReadonlyArray<T>,
  query: string,
  describe: (preset: T) => { readonly name: string; readonly searchText: string },
  limit = 8,
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return presets.slice(0, limit);
  }
  const tokens = trimmed.split(/[\s:/-]+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return presets.slice(0, limit);
  }

  const scored: Array<{ readonly item: T; readonly score: number; readonly index: number }> = [];
  for (let index = 0; index < presets.length; index += 1) {
    const item = presets[index]!;
    const info = describe(item);
    const nameLower = info.name.toLowerCase();
    const haystack = `${nameLower} ${info.searchText.toLowerCase()}`;
    if (!tokens.every((token) => haystack.includes(token))) continue;

    let score = 10;
    if (nameLower === trimmed) score = 100;
    else if (nameLower.startsWith(trimmed)) score = 80;
    else if (nameLower.includes(trimmed)) score = 60;
    else if (tokens.every((token) => nameLower.includes(token))) score = 40;
    scored.push({ item, score, index });
  }

  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

interface LeadingSubagentPresetMatch {
  readonly presetName: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly remainder: string;
}

const LEADING_SUBAGENT_TOKEN_PATTERN = /^([ \t]*)\^([^\s@#^/$:,;()[\]"'`]+)/u;

/**
 * Matches a leading `^<presetName>` at the very start of the prompt.
 * Mid-sentence `^` is intentionally ignored so subagent prompts stay unambiguous.
 */
function matchLeadingSubagentPreset(
  text: string,
  knownPresetNamesLower: ReadonlySet<string>,
  options: { readonly allowEndOfText?: boolean } = {},
): LeadingSubagentPresetMatch | null {
  if (knownPresetNamesLower.size === 0) return null;
  const match = LEADING_SUBAGENT_TOKEN_PATTERN.exec(text);
  if (!match) return null;
  const leadingSpaces = match[1] ?? "";
  const rawName = match[2] ?? "";
  const start = leadingSpaces.length;
  const end = start + 1 + rawName.length;
  const nextChar = text[end];
  const boundaryOk =
    nextChar === undefined ? options.allowEndOfText === true : /\s/u.test(nextChar);
  if (!boundaryOk) return null;
  if (!knownPresetNamesLower.has(rawName.toLowerCase())) return null;
  return {
    presetName: rawName,
    source: text.slice(start, end),
    start,
    end,
    remainder: text.slice(end),
  };
}

interface InlineModelSwitchPresetMatch {
  readonly presetName: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

const INLINE_AT_TOKEN_PATTERN = /(^|\s)@([^\s@#^/$:,;()[\]"'`]+)/gu;

function collectInlineModelSwitchPresets(
  text: string,
  knownPresetNamesLower: ReadonlySet<string>,
  options: { readonly allowEndOfText?: boolean } = {},
): ReadonlyArray<InlineModelSwitchPresetMatch> {
  if (knownPresetNamesLower.size === 0 || !text.includes("@")) return [];
  const matches: InlineModelSwitchPresetMatch[] = [];
  for (const match of text.matchAll(INLINE_AT_TOKEN_PATTERN)) {
    const prefix = match[1] ?? "";
    const rawName = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const end = start + 1 + rawName.length;
    const nextChar = text[end];
    const boundaryOk =
      nextChar === undefined ? options.allowEndOfText === true : /\s/u.test(nextChar);
    if (!boundaryOk) continue;
    if (!knownPresetNamesLower.has(rawName.toLowerCase())) continue;
    matches.push({
      presetName: rawName,
      source: text.slice(start, end),
      start,
      end,
    });
  }
  return matches;
}

export type ResolvedComposerPromptModelPresets =
  | { readonly kind: "none" }
  | {
      readonly kind: "subagent";
      readonly preset: ModelPreset;
      readonly taskText: string;
      readonly source: string;
    }
  | {
      readonly kind: "model-switch";
      readonly preset: ModelPreset;
      readonly cleanedPrompt: string;
      readonly sources: ReadonlyArray<string>;
    };

function stripInlineRanges(
  text: string,
  ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): string {
  if (ranges.length === 0) return text;
  let result = text;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    let start = range.start;
    let end = range.end;
    const before = start > 0 ? result[start - 1] : undefined;
    const after = end < result.length ? result[end] : undefined;
    if (after === " " || after === "\t") {
      end += 1;
    } else if (before === " " || before === "\t") {
      start -= 1;
    }
    result = result.slice(0, start) + result.slice(end);
  }
  return result.trim();
}

/**
 * Resolves send-time `@preset` model switches and leading `^preset message` subagent commands.
 */
export function resolveComposerPromptModelPresets(
  prompt: string,
  presets: ReadonlyArray<ModelPreset>,
): ResolvedComposerPromptModelPresets {
  if (presets.length === 0) return { kind: "none" };
  const known = buildKnownModelPresetNameSet(presets);

  const subagent = matchLeadingSubagentPreset(prompt, known, { allowEndOfText: true });
  if (subagent !== null) {
    const preset = findModelPresetByName(presets, subagent.presetName);
    if (preset !== undefined) {
      return {
        kind: "subagent",
        preset,
        taskText: subagent.remainder.trim(),
        source: subagent.source,
      };
    }
  }

  const inlineSwitches = collectInlineModelSwitchPresets(prompt, known, { allowEndOfText: true });
  if (inlineSwitches.length > 0) {
    const last = inlineSwitches[inlineSwitches.length - 1]!;
    const preset = findModelPresetByName(presets, last.presetName);
    if (preset !== undefined) {
      return {
        kind: "model-switch",
        preset,
        cleanedPrompt: stripInlineRanges(prompt, inlineSwitches),
        sources: inlineSwitches.map((item) => item.source),
      };
    }
  }

  return { kind: "none" };
}
