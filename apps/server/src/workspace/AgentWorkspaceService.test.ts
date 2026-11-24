import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as AgentWorkspaceService from "./AgentWorkspaceService.ts";

const makeTestLayer = (statePrefix: string) =>
  AgentWorkspaceService.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: statePrefix })),
    Layer.provideMerge(NodeServices.layer),
  );

it.layer(makeTestLayer("t3-agent-workspace-test-"))("AgentWorkspaceService", (it) => {
  it.effect(
    "registers workspaces, reads live AGENTS.md edits, rejects duplicates, and unregisters without deleting files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* AgentWorkspaceService.AgentWorkspaceService;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-spec-" });
        const wsA = path.join(root, "coding");
        const wsB = path.join(root, "video");
        const wsDup = path.join(root, "coding-dup");
        const wsBad = path.join(root, "bad-meta");

        yield* fs.makeDirectory(wsA, { recursive: true });
        yield* fs.makeDirectory(wsB, { recursive: true });
        yield* fs.makeDirectory(wsDup, { recursive: true });
        yield* fs.makeDirectory(wsBad, { recursive: true });

        const agentsA = path.join(wsA, "AGENTS.md");
        yield* fs.writeFileString(
          agentsA,
          [
            "---",
            "name: coding",
            "description: Software development across projects.",
            "---",
            "",
            "# Coding",
            "Follow repo conventions.",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(wsB, "AGENTS.md"),
          [
            "---",
            "name: video-production",
            "description: Video direction, assets, and editing.",
            "---",
            "",
            "# Video",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(wsDup, "AGENTS.md"),
          ["---", "name: coding", "description: Duplicate name.", "---", ""].join("\n"),
        );
        yield* fs.writeFileString(path.join(wsBad, "AGENTS.md"), "# No frontmatter\n");

        const regA = yield* service.register(wsA);
        assert.equal(regA.workspace.name, "coding");
        assert.equal(regA.workspace.description, "Software development across projects.");
        assert.equal(regA.catalog.workspaces.length, 1);
        assert.deepEqual(regA.catalog.errors, []);

        // Idempotent repeat registration
        const regAAgain = yield* service.register(wsA);
        assert.equal(regAAgain.catalog.workspaces.length, 1);

        // Reject malformed frontmatter
        const badResult = yield* Effect.result(service.register(wsBad));
        assert.equal(badResult._tag, "Failure");
        if (badResult._tag === "Failure") {
          assert.equal(badResult.failure.code, "invalid_metadata");
        }

        // Reject duplicate name
        const dupResult = yield* Effect.result(service.register(wsDup));
        assert.equal(dupResult._tag, "Failure");
        if (dupResult._tag === "Failure") {
          assert.equal(dupResult.failure.code, "duplicate_name");
        }

        yield* service.register(wsB);

        // Live edit is reflected without re-registering
        yield* fs.writeFileString(
          agentsA,
          [
            "---",
            "name: coding",
            "description: Updated coding description.",
            "---",
            "",
            "# Coding v2",
          ].join("\n"),
        );
        const live = yield* service.readLive("coding");
        assert.equal(live.workspace.description, "Updated coding description.");
        assert.include(live.instructions, "# Coding v2");

        // Unregister removes from catalog while keeping files on disk
        const removed = yield* service.unregister(wsA);
        assert.equal(removed.catalog.workspaces.length, 1);
        assert.equal(removed.catalog.workspaces[0]?.name, "video-production");
        assert.isTrue(yield* fs.exists(agentsA));

        yield* service.unregister(wsB);
        const empty = yield* service.list();
        assert.deepEqual(empty.workspaces, []);
        assert.deepEqual(empty.errors, []);
      }),
  );

  it.effect("reports broken entries as catalog errors and blocks readLive until fixed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* AgentWorkspaceService.AgentWorkspaceService;

      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-err-" });
      const wsGood = path.join(root, "research");
      const wsBroken = path.join(root, "broken");
      yield* fs.makeDirectory(wsGood, { recursive: true });
      yield* fs.makeDirectory(wsBroken, { recursive: true });

      yield* fs.writeFileString(
        path.join(wsGood, "AGENTS.md"),
        "---\nname: research\ndescription: Research notes and experiments.\n---\n# Research\n",
      );
      yield* fs.writeFileString(
        path.join(wsBroken, "AGENTS.md"),
        "---\nname: temp-ws\ndescription: Temporary workspace.\n---\n# Temp\n",
      );

      yield* service.register(wsGood);
      yield* service.register(wsBroken);

      // Corrupt the second workspace after registration
      yield* fs.remove(path.join(wsBroken, "AGENTS.md"));

      const catalog = yield* service.list();
      assert.equal(catalog.workspaces.length, 1);
      assert.equal(catalog.workspaces[0]?.name, "research");
      assert.equal(catalog.errors.length, 1);

      const readBlocked = yield* Effect.result(service.readLive("research"));
      assert.equal(readBlocked._tag, "Failure");
      if (readBlocked._tag === "Failure") {
        assert.equal(readBlocked.failure.code, "catalog_error");
      }

      // Unregistering the broken folder restores activation
      yield* service.unregister(wsBroken);
      const live = yield* service.readLive("research");
      assert.equal(live.workspace.name, "research");

      yield* service.unregister(wsGood);
    }),
  );

  it.effect(
    "creates a spec-compliant workspace, registers it, and guards against overwrites and duplicates",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* AgentWorkspaceService.AgentWorkspaceService;

        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-create-" });
        const writingDir = path.join(root, "writing");

        const created = yield* service.create({
          path: writingDir,
          name: "writing",
          description: "Fiction & essays: drafting, editing #drafts",
          instructions: "# Writing\n\nKeep each project in `works/`.",
        });
        assert.equal(created.workspace.name, "writing");
        assert.equal(created.workspace.description, "Fiction & essays: drafting, editing #drafts");
        assert.equal(created.source, path.join(created.workspace.path, "AGENTS.md"));
        assert.equal(created.catalog.workspaces.length, 1);

        const live = yield* service.readLive("writing");
        assert.equal(live.workspace.description, "Fiction & essays: drafting, editing #drafts");
        assert.include(live.instructions, "# Writing");

        // Refuses to overwrite an existing AGENTS.md
        const overwrite = yield* Effect.result(
          service.create({
            path: writingDir,
            name: "writing-two",
            description: "Attempt to overwrite.",
            instructions: "# Overwrite",
          }),
        );
        assert.equal(overwrite._tag, "Failure");
        if (overwrite._tag === "Failure") {
          assert.equal(overwrite.failure.code, "invalid_path");
        }

        // Rejects duplicate name before creating the directory
        const dupDir = path.join(root, "writing-dup");
        const dup = yield* Effect.result(
          service.create({
            path: dupDir,
            name: "writing",
            description: "Duplicate workspace name.",
            instructions: "# Dup",
          }),
        );
        assert.equal(dup._tag, "Failure");
        if (dup._tag === "Failure") {
          assert.equal(dup.failure.code, "duplicate_name");
        }
        assert.isFalse(yield* fs.exists(dupDir));

        // Rejects frontmatter inside instructions and multiline descriptions
        const badFrontmatter = yield* Effect.result(
          service.create({
            path: path.join(root, "bad-fm"),
            name: "bad-fm",
            description: "Valid description.",
            instructions: "---\nname: bad-fm\ndescription: dup\n---\n# Body",
          }),
        );
        assert.equal(badFrontmatter._tag, "Failure");
        if (badFrontmatter._tag === "Failure") {
          assert.equal(badFrontmatter.failure.code, "invalid_metadata");
        }

        const multilineDesc = yield* Effect.result(
          service.create({
            path: path.join(root, "bad-desc"),
            name: "bad-desc",
            description: "Line one\nLine two",
            instructions: "# Body",
          }),
        );
        assert.equal(multilineDesc._tag, "Failure");
        if (multilineDesc._tag === "Failure") {
          assert.equal(multilineDesc.failure.code, "invalid_metadata");
        }

        // Initializes an existing folder that does not yet have AGENTS.md
        const existingDir = path.join(root, "existing-folder");
        yield* fs.makeDirectory(existingDir, { recursive: true });
        yield* fs.writeFileString(path.join(existingDir, "README.md"), "# Existing\n");
        const initialized = yield* service.create({
          path: existingDir,
          name: "existing-work",
          description: "Existing folder turned into a workspace.",
          instructions: "# Existing work",
        });
        assert.equal(initialized.workspace.name, "existing-work");
        assert.isTrue(yield* fs.exists(path.join(existingDir, "README.md")));

        yield* service.unregister(writingDir);
        yield* service.unregister(existingDir);
      }),
  );
});
