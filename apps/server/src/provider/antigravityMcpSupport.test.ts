// @effect-diagnostics nodeBuiltinImport:off -- isolated filesystem fixtures exercise redirected files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  mergeAntigravityPrivateMcp,
  parseAntigravityPrivateMcp,
  readAntigravityPrivateMcp,
} from "./antigravityMcpSupport.ts";

const source = JSON.stringify({
  mcpServers: {
    shared: { command: "node", args: ["roots-mcp.mjs", "shared"], env: { LANG: "en_GB" } },
  },
});
it.effect(
  "maps private stdio servers without resolving inherited credentials or changing native source",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-private-mcp-")),
      );
      try {
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "config")));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "config", "mcp_config.json"), source),
        );
        expect(yield* readAntigravityPrivateMcp(root)).toEqual([
          {
            name: "shared",
            command: "node",
            args: ["roots-mcp.mjs", "shared"],
            env: [{ name: "LANG", value: "en_GB" }],
          },
        ]);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "config", "mcp_config.json"), "utf8"),
          ),
        ).toBe(source);
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
      }
    }),
);
it("rejects malformed, duplicate, oversized and unsupported remote private configurations safely", () => {
  for (const text of [
    "{",
    '{"mcpServers":{},"mcpServers":{}}',
    '{"mcpServers":{"one":{"command":"node"},"one":{"command":"other"}}}',
    JSON.stringify({ mcpServers: { remote: { url: "https://dummy.invalid/mcp" } } }),
    JSON.stringify({ mcpServers: { unsafe: { command: "node\nother" } } }),
    " ".repeat(256_001),
  ]) {
    expect(() => parseAntigravityPrivateMcp(text)).toThrow();
  }
});
it("rejects inline credentials and literal placeholders without leaking values", () => {
  for (const value of ["DUMMY_PRIVATE_CREDENTIAL", "${DUMMY_SOURCE_KEY}"]) {
    const text = JSON.stringify({
      mcpServers: { private: { command: "node", env: { API_KEY: value } } },
    });
    try {
      parseAntigravityPrivateMcp(text);
      throw new Error("Expected credential validation");
    } catch (error) {
      expect(String(error)).toContain("inherited");
      expect(String(error)).not.toContain(value);
    }
  }
  for (const server of [
    { command: "${DUMMY_COMMAND}" },
    { command: "node", args: ["${DUMMY_SOURCE_KEY}"] },
    { command: "node", env: { ORDINARY: "${DUMMY_SOURCE_KEY}" } },
    { command: "node", args: ["--api-key=DUMMY_PRIVATE_CREDENTIAL"] },
  ]) {
    expect(() =>
      parseAntigravityPrivateMcp(JSON.stringify({ mcpServers: { private: server } })),
    ).toThrow("inherited");
  }
  expect(() =>
    parseAntigravityPrivateMcp(
      JSON.stringify({
        mcpServers: { private: { command: "node", env: { ROOTS_PROFILE: "other" } } },
      }),
    ),
  ).toThrow();
});
it.effect(
  "treats missing private config as empty and rejects redirected directories and hardlinked files",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-private-mcp-")),
      );
      try {
        expect(yield* readAntigravityPrivateMcp(root)).toEqual([]);
        const external = NodePath.join(root, "external");
        yield* Effect.promise(() => NodeFSP.mkdir(external));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(external, "mcp_config.json"), source),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(
            external,
            NodePath.join(root, "config"),
            HostProcess.Platform.defaultValue() === "win32" ? "junction" : "dir",
          ),
        );
        expect((yield* readAntigravityPrivateMcp(root).pipe(Effect.flip)).message).toContain(
          "redirected",
        );
        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, "config")));
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "config")));
        yield* Effect.promise(() =>
          NodeFSP.link(
            NodePath.join(external, "mcp_config.json"),
            NodePath.join(root, "config", "mcp_config.json"),
          ),
        );
        expect((yield* readAntigravityPrivateMcp(root).pipe(Effect.flip)).message).toContain(
          "redirected",
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
      }
    }),
);
it("preserves T3 device servers and private stdio in every negotiated transport and activation override", () => {
  const privateServers = parseAntigravityPrivateMcp(source);
  const device = { name: "t3-code", command: "node", args: ["device-bridge"], env: [] };
  const options = {
    mcpServers: [device],
    acpMcpServers: [{ type: "acp" as const, name: "t3-code", serverId: "t3-code" }],
    httpMcpServers: [
      { type: "http" as const, name: "t3-code", url: "https://dummy.invalid/mcp", headers: [] },
    ],
  };
  const combined = mergeAntigravityPrivateMcp(options, privateServers);
  for (const transport of ["mcpServers", "acpMcpServers", "httpMcpServers"] as const)
    expect(combined[transport].map((server) => server.name)).toEqual(["t3-code", "shared"]);
  expect(options.mcpServers).toEqual([device]);
  const activation = mergeAntigravityPrivateMcp(
    { mcpServers: [{ ...device, args: ["replacement-device"] }] },
    privateServers,
  );
  expect(activation.mcpServers.map((server) => server.name)).toEqual(["t3-code", "shared"]);
  expect(
    mergeAntigravityPrivateMcp({ mcpServers: [] }, privateServers).acpMcpServers,
  ).toBeUndefined();
  expect(() => mergeAntigravityPrivateMcp({ mcpServers: privateServers }, privateServers)).toThrow(
    "conflicts",
  );
});
