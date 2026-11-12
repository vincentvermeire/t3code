// @effect-diagnostics nodeBuiltinImport:off -- the fake `op` reads the template the driver wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeVM from "node:vm";

import { OnePasswordAccount } from "../shared/definition.ts";
import { driver } from "./driver.ts";

const encoder = new TextEncoder();
const account = OnePasswordAccount.make("my.1password.com");

type OpResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
};

function fakeOp(answer: (args: ReadonlyArray<string>, environment: NodeJS.ProcessEnv) => OpResult) {
  const invocations: Array<ReadonlyArray<string>> = [];
  const environments: Array<NodeJS.ProcessEnv> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          assert.isTrue(ChildProcess.isStandardCommand(command));
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected a command");
          const args = command.args.map((word) =>
            Redacted.isRedacted(word) ? Redacted.value(word) : word,
          );
          const environment = Object.fromEntries(
            Object.entries(command.options.env ?? {}).map(([name, value]) => [
              name,
              Redacted.isRedacted(value) ? Redacted.value(value) : value,
            ]),
          );
          invocations.push(args);
          environments.push(environment);
          Deferred.doneUnsafe(spawned, Effect.void);
          const result = answer(args, environment);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: result.hang
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode(result.stdout ?? "")),
            stderr: Stream.make(encoder.encode(result.stderr ?? "")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    NodeFileSystem.layer,
    NodeCrypto.layer,
  );
  return { layer, invocations, environments, spawned };
}

const runFrom =
  (
    environments: Readonly<Record<string, Readonly<Record<string, string>>>>,
    items: Readonly<Record<string, string>> = {},
  ) =>
  (args: ReadonlyArray<string>, inherited: NodeJS.ProcessEnv): OpResult => {
    if (!args.includes("run")) return { code: 1 };
    const id = args[args.indexOf("--environment") + 1]!;
    const environment = { ...inherited, ...environments[id] };
    for (const [name, value] of Object.entries(environment)) {
      if (value?.startsWith("op://") && items[value] !== undefined)
        environment[name] = items[value];
    }
    const fakeProcess = {
      env: environment,
      argv: ["node", args.at(-2), args.at(-1)],
      exitCode: 0,
      stdout: {
        write: (value: string) => {
          stdout += value;
        },
      },
    };
    let stdout = "";
    NodeVM.runInNewContext(NodeFS.readFileSync(args.at(-2)!, "utf8"), { process: fakeProcess });
    return { stdout, code: fakeProcess.exitCode };
  };

// Answers `op inject` by substituting each `{{ reference }}` in the template file it was handed.
const injectFrom =
  (secrets: Readonly<Record<string, string>>) =>
  (args: ReadonlyArray<string>): OpResult => {
    const template = NodeFS.readFileSync(args[args.indexOf("-i") + 1]!, "utf8");
    return { stdout: template.replace(/\{\{ (\S+) \}\}/g, (_, reference) => secrets[reference]!) };
  };

describe("1Password driver", () => {
  it.effect("reads one reference from the account", () => {
    const op = fakeOp(() => ({ stdout: "sk-live" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        "sk-live",
      ]);
      assert.deepStrictEqual(op.invocations, [
        [
          "--cache=false",
          "read",
          "--account=my.1password.com",
          "--no-newline",
          "op://Private/OpenAI/credential",
        ],
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads a failed reference as undefined", () => {
    const op = fakeOp(() => ({ code: 1, stderr: "[ERROR] account is locked" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op://Private/OpenAI/credential"]), [
        undefined,
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("reads every reference in a single call", () => {
    const op = fakeOp(
      injectFrom({
        "op://Private/OpenAI/credential": "sk-a",
        "op://Private/Anthropic/key": " sk-b\n",
      }),
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Anthropic/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", " sk-b\n"]);
      assert.strictEqual(op.invocations.length, 1);
      assert.deepStrictEqual(op.invocations[0]?.slice(0, 3), [
        "--cache=false",
        "inject",
        "--account=my.1password.com",
      ]);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("falls back to one read at a time when the batch fails", () => {
    const op = fakeOp((args) =>
      args.includes("inject")
        ? { code: 1, stderr: '[ERROR] could not resolve "op://Private/Gone/key"' }
        : args.at(-1) === "op://Private/Gone/key"
          ? { code: 1, stderr: "[ERROR] item not found" }
          : { stdout: "sk-a" },
    );
    return Effect.gen(function* () {
      const values = yield* driver.read({ account }, [
        "op://Private/OpenAI/credential",
        "op://Private/Gone/key",
      ]);

      assert.deepStrictEqual(values, ["sk-a", undefined]);
      assert.strictEqual(op.invocations.length, 3);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("does not read one at a time after the batch times out", () => {
    const op = fakeOp(() => ({ hang: true }));
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op://Private/OpenAI/credential", "op://Private/Anthropic/key"])
        .pipe(Effect.forkChild);
      yield* Deferred.await(op.spawned);
      yield* TestClock.adjust("1 minute");

      assert.deepStrictEqual(yield* Fiber.join(reading), [undefined, undefined]);
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect(
    "captures an Environment and mixed item references once, preserving values and order",
    () => {
      const op = fakeOp(
        runFrom(
          { "env-a": { API_KEY: " env-secret\n\n", OTHER: "other", UNREQUESTED: "private" } },
          { "op://Private/OpenAI/credential": " item-secret \n" },
        ),
      );
      return Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* driver.read({ account }, [
            "op-env://env-a/API_KEY",
            "op://Private/OpenAI/credential",
            "op-env://env-a/OTHER",
            "op-env://env-a/API_KEY",
            "op://Private/OpenAI/credential",
          ]),
          [" env-secret\n\n", " item-secret \n", "other", " env-secret\n\n", " item-secret \n"],
        );
        assert.strictEqual(op.invocations.length, 1);
        assert.deepStrictEqual(op.invocations[0]?.slice(0, 7), [
          "--cache=false",
          "run",
          "--account=my.1password.com",
          "--no-masking",
          "--environment",
          "env-a",
          "--",
        ]);
        const request = JSON.parse(op.invocations[0]!.at(-1)!) as { names: Array<string> };
        assert.strictEqual(request.names.length, 3);
        assert.isFalse(request.names.includes("UNREQUESTED"));
      }).pipe(Effect.provide(op.layer));
    },
  );

  it.effect("keeps overlapping variables in separate Environment captures", () => {
    const op = fakeOp(runFrom({ "env-a": { API_KEY: "a" }, "env-b": { API_KEY: "b" } }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* driver.read({ account }, [
          "op-env://env-b/API_KEY",
          "op-env://env-a/API_KEY",
          "op-env://env-b/API_KEY",
        ]),
        ["b", "a", "b"],
      );
      assert.strictEqual(op.invocations.length, 2);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("preserves successful references when an Environment variable is missing", () => {
    const op = fakeOp(
      runFrom(
        { "env-a": { PRESENT: "environment-secret" } },
        { "op://Private/OpenAI/credential": "item-secret" },
      ),
    );
    return Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* driver.read({ account }, [
          "op-env://env-a/MISSING",
          "op-env://env-a/PRESENT",
          "op://Private/OpenAI/credential",
        ]),
        [undefined, "environment-secret", "item-secret"],
      );
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("runs the packaged capture helper with Unicode and exact whitespace", () => {
    const value = " \t秘密 café 🦊\r\nline two\n\n";
    const op = fakeOp((args, environment) => {
      const result = NodeChildProcess.spawnSync(args.at(-3)!, args.slice(-2), {
        env: { ...environment, API_KEY: value, UNREQUESTED: "never-captured" },
        encoding: "utf8",
        windowsHide: true,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1 };
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op-env://env-a/API_KEY"]), [value]);
      assert.strictEqual(op.invocations.length, 1);
      assert.isFalse(op.invocations[0]!.at(-1)!.includes("UNREQUESTED"));
      assert.isFalse(NodeFS.existsSync(op.invocations[0]!.at(-2)!));
    }).pipe(
      Effect.provideService(HostProcess.Environment, {
        API_KEY: "inherited-dummy",
        UNREQUESTED: "dummy",
      }),
      Effect.provide(op.layer),
    );
  });

  it.effect("uses discovered external Node for a standalone executable", () => {
    const op = fakeOp(runFrom({ "env-a": { API_KEY: "selected" } }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op-env://env-a/API_KEY"]), [
        "selected",
      ]);
      assert.strictEqual(op.invocations[0]!.at(-3), "C:\\runtime\\node.exe");
    }).pipe(
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.ExecutablePath, "C:\\app\\t3.exe"),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, (command) =>
        command === "node" ? "C:\\runtime\\node.exe" : undefined,
      ),
      Effect.provide(op.layer),
    );
  });

  it.effect("fails standalone capture when external Node cannot start", () => {
    const op = fakeOp(() => ({ code: 1, stderr: "external Node is unavailable" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op-env://env-a/API_KEY"]), [
        undefined,
      ]);
      assert.strictEqual(op.invocations[0]!.at(-3), "node");
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.ExecutablePath, "C:\\app\\t3.exe"),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => undefined),
      Effect.provide(op.layer),
    );
  });

  it.effect("rejects missing, blank, and unresolved values without inherited fallback", () => {
    const op = fakeOp(
      runFrom({
        "env-a": {},
        "env-b": { KEY: " \n" },
        "env-c": { KEY: "op://Private/Missing/key" },
      }),
    );
    return Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* driver.read({ account }, [
          "op-env://env-a/KEY",
          "op-env://env-b/KEY",
          "op-env://env-c/KEY",
        ]),
        [undefined, undefined, undefined],
      );
      for (const environment of op.environments) {
        assert.isUndefined(environment.KEY);
        assert.isUndefined(environment.key);
        assert.isUndefined(environment.NODE_OPTIONS);
        assert.isUndefined(environment.UNRELATED_REF);
      }
      assert.strictEqual(op.invocations.length, 3);
    }).pipe(
      Effect.provideService(HostProcess.Environment, {
        KEY: "ambient-secret",
        key: "ambient-secret",
        NODE_OPTIONS: "--require unsafe",
        UNRELATED_REF: "op://Private/Unrelated/key",
        PATH: "",
      }),
      Effect.provide(op.layer),
    );
  });

  it.effect("does not expose unmasked output when capture fails", () => {
    const secret = "never-log-this-secret";
    const op = fakeOp(() => ({ code: 1, stdout: secret, stderr: secret }));
    const logs: Array<unknown> = [];
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read({ account }, ["op-env://env-a/API_KEY"]), [
        undefined,
      ]);
      assert.strictEqual(op.invocations.length, 1);
      assert.isFalse(JSON.stringify(logs).includes(secret));
    }).pipe(
      Effect.provide(
        Layer.merge(
          op.layer,
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
      ),
    );
  });

  it.effect("rejects malformed capture data and unrequested values", () => {
    const op = fakeOp((args) => {
      const environmentId = args[args.indexOf("--environment") + 1];
      return {
        stdout:
          environmentId === "env-a"
            ? "not-json-with-secret"
            : JSON.stringify({ API_KEY: "selected", EXTRA: "unrequested-secret" }),
      };
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* driver.read({ account }, ["op-env://env-a/API_KEY", "op-env://env-b/API_KEY"]),
        [undefined, undefined],
      );
      assert.strictEqual(op.invocations.length, 2);
    }).pipe(Effect.provide(op.layer));
  });

  it.effect("does not retry an Environment capture after it times out", () => {
    const op = fakeOp(() => ({ hang: true, stdout: "unmasked", stderr: "unmasked" }));
    return Effect.gen(function* () {
      const reading = yield* driver
        .read({ account }, ["op-env://env-a/API_KEY", "op://Private/OpenAI/credential"])
        .pipe(Effect.forkChild);
      yield* Deferred.await(op.spawned);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* Fiber.join(reading), [undefined, undefined]);
      assert.strictEqual(op.invocations.length, 1);
    }).pipe(Effect.provide(op.layer));
  });
});
