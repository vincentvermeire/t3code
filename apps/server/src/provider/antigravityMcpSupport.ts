// @effect-diagnostics nodeBuiltinImport:off -- bounded private files require lstat and descriptor checks.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";

const MAX_BYTES = 256_000;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sensitive = /api_?key|token|secret|password|credential|authorization/i;
const reasons = [
  "invalid",
  "redirected",
  "unsupported",
  "credential",
  "collision",
  "unreadable",
] as const;
export class AntigravityPrivateMcpError extends Schema.TaggedError<AntigravityPrivateMcpError>()(
  "AntigravityPrivateMcpError",
  { reason: Schema.Literals(reasons) },
) {
  override get message(): string {
    return {
      invalid: "The private Antigravity MCP configuration is invalid or exceeds its limit.",
      redirected: "The private Antigravity MCP configuration is redirected or not a regular file.",
      unsupported: "Private Antigravity MCP configuration currently supports stdio servers only.",
      credential:
        "Private Antigravity MCP credentials must be inherited from the instance environment; inline credentials and placeholders are unsupported.",
      collision: "A private Antigravity MCP server name conflicts with an existing session server.",
      unreadable: "The private Antigravity MCP configuration could not be read.",
    }[this.reason];
  }
}
const isPrivateMcpError = Schema.is(AntigravityPrivateMcpError);
function fail(reason: (typeof reasons)[number]): never {
  throw new AntigravityPrivateMcpError({ reason });
}
function uniqueJsonKeys(text: string) {
  const stack: Array<Set<string> | null> = [];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
    if (token[0] === "{") stack.push(new Set());
    else if (token[0] === "[") stack.push(null);
    else if (token[0] === "}" || token[0] === "]") stack.pop();
    else {
      let following = token.index + token[0].length;
      while (/\s/.test(text[following] ?? "")) following++;
      if (text[following] !== ":") continue;
      const keys = stack.at(-1),
        key: string = JSON.parse(token[0]);
      if (keys?.has(key)) fail("invalid");
      keys?.add(key);
    }
  }
}
export function parseAntigravityPrivateMcp(text: string): ReadonlyArray<AcpSchema.McpServer> {
  if (Buffer.byteLength(text) > MAX_BYTES) fail("invalid");
  let value: unknown;
  try {
    value = JSON.parse(text);
    uniqueJsonKeys(text);
  } catch {
    fail("invalid");
  }
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== "mcpServers") ||
    !record(value.mcpServers)
  )
    fail("invalid");
  const entries = Object.entries(value.mcpServers);
  if (entries.length > 64) fail("invalid");
  return entries.map(([name, server]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || !record(server)) fail("invalid");
    if (
      server.url !== undefined ||
      server.serverUrl !== undefined ||
      (server.type !== undefined && server.type !== "stdio")
    )
      fail("unsupported");
    if (Object.keys(server).some((key) => !["type", "command", "args", "env"].includes(key)))
      fail("invalid");
    if (
      typeof server.command !== "string" ||
      !server.command.trim() ||
      server.command.length > 8_192 ||
      /[\r\n\0]/.test(server.command)
    )
      fail("invalid");
    if (server.command.includes("${")) fail("credential");
    const args = server.args ?? [];
    if (
      !Array.isArray(args) ||
      args.length > 128 ||
      args.some((arg) => typeof arg !== "string" || arg.length > 8_192 || /[\r\n\0]/.test(arg))
    )
      fail("invalid");
    if (
      args.some((arg) => arg.includes("${")) ||
      args.some((arg) =>
        /^--?(?:api[-_]?key|token|password|secret|authorization)(?:=|$)/i.test(arg),
      )
    )
      fail("credential");
    const environment = server.env ?? {};
    if (!record(environment) || Object.keys(environment).length > 128) fail("invalid");
    const names = new Set<string>();
    const env = Object.entries(environment).map(([name, value]) => {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        names.has(name.toUpperCase()) ||
        typeof value !== "string" ||
        value.length > 8_192 ||
        value.includes("\0")
      )
        fail("invalid");
      names.add(name.toUpperCase());
      if (sensitive.test(name) || /^ROOTS_/i.test(name) || value.includes("${")) fail("credential");
      return { name, value };
    });
    return { name, command: server.command, args: args as Array<string>, env };
  });
}
async function readPrivateFile(profileDirectory: string) {
  const root = await NodeFSP.realpath(profileDirectory);
  const config = NodePath.join(root, "config"),
    file = NodePath.join(config, "mcp_config.json");
  const missing = (error: unknown) => record(error) && error.code === "ENOENT";
  const directory = await NodeFSP.lstat(config).catch((error) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!directory) return [];
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (await NodeFSP.realpath(config)) !== config
  )
    fail("redirected");
  const info = await NodeFSP.lstat(file).catch((error) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("redirected");
  if (info.size > MAX_BYTES) fail("invalid");
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev
    )
      fail("redirected");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) fail("invalid");
    return parseAntigravityPrivateMcp(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}
export const readAntigravityPrivateMcp = Effect.fn("readAntigravityPrivateMcp")(
  (profileDirectory: string) =>
    Effect.tryPromise({
      try: () => readPrivateFile(profileDirectory),
      catch: (cause) =>
        isPrivateMcpError(cause) ? cause : new AntigravityPrivateMcpError({ reason: "unreadable" }),
    }),
);
type McpOptions = {
  readonly mcpServers?: ReadonlyArray<AcpSchema.McpServer>;
  readonly acpMcpServers?: ReadonlyArray<AcpSchema.McpServer>;
  readonly httpMcpServers?: ReadonlyArray<AcpSchema.McpServer>;
};
export function mergeAntigravityPrivateMcp<T extends McpOptions>(
  options: T,
  privateServers: ReadonlyArray<AcpSchema.McpServer>,
): T & McpOptions {
  const append = (servers: ReadonlyArray<AcpSchema.McpServer>) => {
    const names = new Set(servers.map((server) => server.name));
    if (privateServers.some((server) => names.has(server.name))) fail("collision");
    return [...servers, ...privateServers];
  };
  return {
    ...options,
    mcpServers: append(options.mcpServers ?? []),
    ...(options.acpMcpServers?.length ? { acpMcpServers: append(options.acpMcpServers) } : {}),
    ...(options.httpMcpServers?.length ? { httpMcpServers: append(options.httpMcpServers) } : {}),
  };
}
