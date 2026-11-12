import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

import {
  definition,
  parseEnvironmentReference,
  type OnePasswordAccount,
} from "../shared/definition.ts";

const ONE_PASSWORD_BINARY = "op";
// Bounds a read long enough to reach for a fingerprint reader, short enough not to wedge a rebuild.
const READ_TIMEOUT = Duration.seconds(45);

// `--cache=false` skips the `op daemon`, which hangs on prompts a background server cannot show.
const runOnePassword = Effect.fn("OnePasswordDriver.runOnePassword")(function* (
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const spawnCommand = yield* resolveSpawnCommand(
    ONE_PASSWORD_BINARY,
    ["--cache=false", ...args],
    environment ? { env: environment } : {},
  );
  return yield* spawnAndCollect(
    ONE_PASSWORD_BINARY,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      shell: spawnCommand.shell,
      ...(environment
        ? {
            env: Object.fromEntries(
              Object.entries(environment).flatMap(([name, value]) =>
                value === undefined ? [] : [[name, Redacted.make(value)]],
              ),
            ),
            extendEnv: false,
          }
        : {}),
    }),
  );
});

// A secret is passed on verbatim; surrounding whitespace can be part of it.
const nonEmpty = (value: string) => (value.trim().length > 0 ? value : undefined);

const CAPTURE_SCRIPT = `const { names } = JSON.parse(process.argv.at(-1));
const values = Object.fromEntries(names.map(name => {
  const value = Object.hasOwn(process.env, name) ? process.env[name] : undefined;
  return [name, typeof value === 'string' && value.trim() && !value.startsWith('op://') ? value : null];
}));
process.stdout.write(JSON.stringify(values));`;
const encodeCaptureRequest = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ names: Schema.Array(Schema.String) })),
);
const parseCaptureValues = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
);

const readEnvironment = Effect.fn("OnePasswordDriver.readEnvironment")(function* (
  account: OnePasswordAccount,
  environmentId: string,
  variables: ReadonlyArray<string>,
  itemReferences: ReadonlyArray<string>,
  selectedVariables: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const nonce = (yield* (yield* SecureRandom.SecureRandom).uuidV4()).replaceAll("-", "");
  const selected = itemReferences.map((reference, index) => ({
    name: `T3_OP_ITEM_${nonce}_${index}`,
    reference,
  }));
  const removed = new Set(selectedVariables.map((name) => name.toUpperCase()));
  const environment = Object.fromEntries(
    Object.entries(yield* HostProcess.Environment).filter(
      ([name, value]) =>
        !removed.has(name.toUpperCase()) &&
        name.toUpperCase() !== "NODE_OPTIONS" &&
        !value?.startsWith("op://"),
    ),
  );
  for (const { name, reference } of selected) environment[name] = reference;
  const names = [...variables, ...selected.map(({ name }) => name)];
  const helperPath = yield* fileSystem.makeTempFileScoped({
    prefix: "t3code-op-capture-",
    suffix: ".cjs",
  });
  yield* fileSystem.writeFileString(helperPath, CAPTURE_SCRIPT);
  // SEA executables run their embedded application; only Node/Electron can run the fixed helper.
  const executable = (yield* HostProcess.IsExecutable) ? "node" : yield* HostProcess.ExecutablePath;
  const helperCommand = yield* resolveSpawnCommand(
    executable,
    [helperPath, yield* encodeCaptureRequest({ names })],
    { env: environment },
  );
  if (helperCommand.shell) return undefined;
  const result = yield* runOnePassword(
    [
      "run",
      `--account=${account}`,
      "--no-masking",
      "--environment",
      environmentId,
      "--",
      helperCommand.command,
      ...helperCommand.args,
    ],
    environment,
  );
  const decoded = parseCaptureValues(result.stdout);
  if (result.code !== 0 || Option.isNone(decoded)) return undefined;
  const values = decoded.value;
  if (Object.keys(values).length !== names.length) return undefined;
  const captured = new Map<string, string | undefined>();
  for (const name of names) {
    if (!Object.hasOwn(values, name)) return undefined;
    const value = values[name];
    if (value === null) {
      captured.set(name, undefined);
      continue;
    }
    if (typeof value !== "string" || !nonEmpty(value) || value.startsWith("op://"))
      return undefined;
    captured.set(name, value);
  }
  return new Map([
    ...variables.map(
      (variable) => [`op-env://${environmentId}/${variable}`, captured.get(variable)] as const,
    ),
    ...selected.map(({ name, reference }) => [reference, captured.get(name)] as const),
  ]);
}, Effect.scoped);

const readOne = Effect.fn("OnePasswordDriver.readOne")(function* (
  account: OnePasswordAccount,
  reference: string,
) {
  const result = yield* runOnePassword(["read", `--account=${account}`, "--no-newline", reference]);
  if (result.code !== 0) {
    yield* Effect.logWarning("Could not read secret from 1Password", {
      stage: "read",
      exitCode: result.code,
    });
    return undefined;
  }
  return nonEmpty(result.stdout);
});

// One `op inject` costs one unlock for every reference in the template. `op` ignores piped stdin
// from Node, so the template goes through a temp file. A random separator after every reference
// keeps one secret from shifting the others, and leaves any trailing newline outside the values.
const readTogether = Effect.fn("OnePasswordDriver.readTogether")(function* (
  account: OnePasswordAccount,
  references: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const separator = `__t3-secret-${yield* (yield* SecureRandom.SecureRandom).uuidV4()}__`;
  const templatePath = yield* fileSystem.makeTempFileScoped({ prefix: "t3code-op-inject-" });
  yield* fileSystem.writeFileString(
    templatePath,
    references.map((reference) => `{{ ${reference} }}${separator}`).join(""),
  );
  const result = yield* runOnePassword(["inject", `--account=${account}`, "-i", templatePath]);
  const values = result.stdout.split(separator);
  const trailing = values.pop();
  if (
    result.code !== 0 ||
    values.length !== references.length ||
    trailing === undefined ||
    trailing.trim().length > 0
  ) {
    yield* Effect.logWarning("Could not batch-read secrets from 1Password", {
      stage: "inject",
      exitCode: result.code,
      references: references.length,
    });
    return undefined;
  }
  return values.map(nonEmpty);
}, Effect.scoped);

/** `None` when 1Password did not answer in time; a failed run reads as `Some(undefined)`. */
const bounded = <A, E extends { readonly _tag: string }, R>(
  stage: "read" | "inject" | "environment",
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  effect.pipe(
    Effect.timeoutOption(READ_TIMEOUT),
    Effect.tap((outcome) =>
      Option.isNone(outcome)
        ? Effect.logWarning("1Password did not answer in time", { stage })
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not run 1Password", { stage, error: error._tag }).pipe(
        Effect.as(Option.some(undefined)),
      ),
    ),
  );

const readItems = Effect.fn("OnePasswordDriver.readItems")(function* (
  account: OnePasswordAccount,
  references: ReadonlyArray<string>,
) {
  if (references.length > 1) {
    const together = yield* bounded("inject", readTogether(account, references));
    // Reading one by one after a timeout would only wait that long again for each reference.
    if (Option.isNone(together)) return references.map(() => undefined);
    if (together.value !== undefined) return together.value;
  }
  return yield* Effect.forEach(references, (reference) =>
    bounded("read", readOne(account, reference)).pipe(Effect.map(Option.getOrUndefined)),
  );
});

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  read: Effect.fn("OnePasswordDriver.read")(function* ({ account }, references) {
    const environments = new Map<string, Set<string>>();
    const items = new Set<string>();
    for (const reference of references) {
      const parsed = parseEnvironmentReference(reference);
      if (!parsed) {
        items.add(reference);
        continue;
      }
      const variables = environments.get(parsed.environmentId) ?? new Set<string>();
      variables.add(parsed.variable);
      environments.set(parsed.environmentId, variables);
    }
    if (environments.size === 0) return yield* readItems(account, references);
    const values = new Map<string, string | undefined>();
    const selectedVariables = [...environments.values()].flatMap((variables) => [...variables]);
    let includeItems = true;
    for (const [environmentId, variables] of environments) {
      const attachedItems = includeItems ? [...items] : [];
      includeItems = false;
      const captured = yield* bounded(
        "environment",
        readEnvironment(account, environmentId, [...variables], attachedItems, selectedVariables),
      );
      if (Option.isNone(captured)) {
        for (const reference of attachedItems) values.set(reference, undefined);
      } else if (captured.value !== undefined) {
        for (const [reference, value] of captured.value) values.set(reference, value);
      } else if (attachedItems.length > 0) {
        const itemValues = yield* readItems(account, attachedItems);
        for (const [index, reference] of attachedItems.entries())
          values.set(reference, itemValues[index]);
      }
    }
    return references.map((reference) => values.get(reference));
  }),
});
