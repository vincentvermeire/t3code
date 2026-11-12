import { it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  ServerSettingsError,
  TextGenerationError,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as TextGenerators from "./TextGenerators.ts";

const projectId = ProjectId.make("project-a");
const helper = ProviderInstanceId.make("helper");
const chat = ProviderInstanceId.make("project-chat");
const alternate = ProviderInstanceId.make("alternate-chat");
const auxiliary = ProviderInstanceId.make("auxiliary");
const selected = { instanceId: helper, model: "helper-model" };
const writer = { instanceId: helper, model: "writer-model" };
const secretProvider = SecretProviderId.make("test-secrets");
const generator = (id: string, reference: string): TextGeneratorConfig => ({
  kind: "openaiCompatible",
  enabled: true,
  label: id,
  baseUrl: `https://${id}.test/v1`,
  apiKey: { provider: secretProvider, reference },
});
const generators = {
  [helper]: generator("helper", "helperPaid"),
  [chat]: generator("project-chat", "projectPaid"),
  [alternate]: generator("alternate-chat", "alternateChatPaid"),
  [auxiliary]: generator("auxiliary", "auxiliaryPaid"),
};
const settings = {
  textGenerationFallbackPolicy: "selected-only",
  textGenerationModelSelection: { instanceId: auxiliary, model: "auxiliary-model" },
  projectSettingsOverrides: {
    [projectId]: {
      textGenerationModelSelection: selected,
      sourceControlWriterModelSelection: writer,
    },
  },
  textGenerators: generators,
} as const;
const input = {
  cwd: "/unused",
  projectId,
  modelSelection: { instanceId: alternate, model: "chat" },
};

const invoke = (
  service: TextGeneration.TextGeneration["Service"],
  operation: string,
): Effect.Effect<
  | TextGeneration.ThreadTitleGenerationResult
  | TextGeneration.BranchNameGenerationResult
  | TextGeneration.CommitMessageGenerationResult
  | TextGeneration.TranscriptionPostProcessingResult,
  TextGenerationError
> => {
  switch (operation) {
    case "title":
      return service.generateThreadTitle({ ...input, message: "Fix login", linkedContext: "" });
    case "branch":
      return service.generateBranchName({ ...input, message: "Fix login" });
    case "commit":
      return service.generateCommitMessage({
        ...input,
        branch: null,
        stagedSummary: "",
        stagedPatch: "",
      });
    case "pr":
      return service.generatePrContent({
        ...input,
        baseBranch: "main",
        headBranch: "fix",
        commitSummary: "",
        diffSummary: "",
        diffPatch: "",
      });
    default:
      return service.generateTranscriptionPostProcessing({
        cwd: "/unused",
        prompt: "Clean up",
        modelSelection: input.modelSelection,
      });
  }
};

const makeService = (
  overrides: Partial<ServerSettings> = {},
  instances: ProviderInstance[] = [],
  unavailableSecret = false,
) => {
  const reads: string[] = [];
  return {
    reads,
    service: TextGeneration.TextGeneration.pipe(
      Effect.provide(
        Layer.effect(TextGeneration.TextGeneration, TextGeneration.make).pipe(
          Layer.provide(Layer.effect(TextGenerators.TextGenerators, TextGenerators.make)),
          Layer.provide(
            Layer.mergeAll(
              ServerSettingsService.layerTest({ ...settings, ...overrides }),
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                listInstances: Effect.succeed(instances),
                getInstance: (id) =>
                  Effect.succeed(instances.find((instance) => instance.instanceId === id)),
              }),
              Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
                resolveLink: () => Effect.die("unused"),
              }),
              Layer.mock(SecretResolver.SecretResolver)({
                read: (references) =>
                  Effect.sync(() =>
                    references.map(({ reference }) => {
                      reads.push(reference);
                      return unavailableSecret ? undefined : `${reference}-dummy`;
                    }),
                  ),
                label: () => Effect.succeed("Test secrets"),
              }),
              FetchHttpClient.layer,
            ),
          ),
        ),
      ),
    ),
  };
};

it.effect.each(["title", "branch", "commit", "pr", "cleanup"])(
  "selected-only %s uses the configured helper rather than the alternate chat key",
  (operation) =>
    Effect.gen(function* () {
      const expectedId = operation === "cleanup" ? auxiliary : helper;
      const expectedModel =
        operation === "cleanup"
          ? "auxiliary-model"
          : operation === "title"
            ? "helper-model"
            : "writer-model";
      const upstream = vi.fn<typeof fetch>(async (url, init) => {
        expect(new URL(String(url)).hostname).toBe(`${expectedId}.test`);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${operation === "cleanup" ? "auxiliaryPaid" : "helperPaid"}-dummy`,
        );
        expect(JSON.parse(String(init?.body)).model).toBe(expectedModel);
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  title: "Fix login",
                  branch: "fix/login",
                  subject: "Fix login",
                  body: "",
                  transcription: "Fix login",
                }),
              },
            },
          ],
        });
      });
      const fixture = makeService();
      const service = yield* fixture.service;
      yield* invoke(service, operation).pipe(
        Effect.provideService(FetchHttpClient.Fetch, upstream),
      );
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(fixture.reads).toEqual([operation === "cleanup" ? "auxiliaryPaid" : "helperPaid"]);
    }),
);

it.effect.each(["removed", "disabled", "credential", "http", "malformed", "timeout"])(
  "selected-only generator %s fails without using another configured account",
  (state) =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () => {
        if (state === "timeout") throw new DOMException("Timed out", "TimeoutError");
        if (state === "http")
          return Response.json({ error: { message: "Unavailable" } }, { status: 503 });
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: "invalid JSON" } }],
        });
      });
      const { [helper]: _helper, ...others } = generators;
      const fixture = makeService(
        {
          textGenerators:
            state === "removed"
              ? others
              : {
                  ...generators,
                  [helper]: { ...generators[helper]!, enabled: state !== "disabled" },
                },
        },
        [],
        state === "credential",
      );
      const service = yield* fixture.service;
      const failure = yield* Effect.flip(
        invoke(service, "title").pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      );
      expect(failure._tag).toBe("TextGenerationError");
      expect(upstream).toHaveBeenCalledTimes(
        ["removed", "disabled", "credential"].includes(state) ? 0 : 1,
      );
      expect(fixture.reads.every((reference) => reference === "helperPaid")).toBe(true);
    }),
);

it.effect("unreadable settings fail before an account is called", () =>
  Effect.gen(function* () {
    const calls = vi.fn();
    const service = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            getSettings: Effect.fail(
              new ServerSettingsError({
                settingsPath: "/settings",
                operation: "read-file",
                cause: new Error("Unreadable"),
              }),
            ),
          }),
          Layer.mock(TextGenerators.TextGenerators)({
            runner: () =>
              Effect.sync(() => {
                calls();
                return undefined;
              }),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused"),
          }),
        ),
      ),
    );
    expect((yield* Effect.flip(invoke(service, "title"))).detail).toContain("Could not read");
    expect(calls).not.toHaveBeenCalled();
  }),
);

it.effect("a selected-only project cannot inherit a normalized allow-policy target", () =>
  Effect.gen(function* () {
    const fixture = makeService({
      textGenerationFallbackPolicy: "allow",
      projectSettingsOverrides: { [projectId]: { textGenerationFallbackPolicy: "selected-only" } },
    });
    const service = yield* fixture.service;
    const failure = yield* Effect.flip(invoke(service, "title"));
    expect(failure.detail).toContain("require an explicit project");
    expect(fixture.reads).toEqual([]);
  }),
);

it.effect("allow keeps the caller's native helper selection", () =>
  Effect.gen(function* () {
    const fixture = makeService({ textGenerationFallbackPolicy: "allow" });
    const upstream = vi.fn<typeof fetch>(async (url) => {
      expect(new URL(String(url)).hostname).toBe("alternate-chat.test");
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"title":"Fix login"}' } }],
      });
    });
    const service = yield* fixture.service;
    yield* invoke(service, "title").pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(fixture.reads).toEqual(["alternateChatPaid"]);
    expect(upstream).toHaveBeenCalledTimes(1);
  }),
);

it.effect.each([
  "ready",
  "removed",
  "disabled",
  "unauthenticated",
  "not-installed",
  "exhausted",
  "unavailable",
  "invalid",
  "failed",
  "generator",
])("selected-only review agent %s preserves the configured selection", (state) =>
  Effect.gen(function* () {
    const calls: ModelSelection[] = [];
    const instances = [helper, alternate].flatMap((instanceId) => {
      if (instanceId === helper && state === "removed") return [];
      const isSelected = instanceId === helper;
      const snapshot: ServerProvider = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        enabled: !(isSelected && state === "disabled"),
        installed: !(isSelected && state === "not-installed"),
        status: isSelected && state === "invalid" ? "error" : "ready",
        auth: {
          status: isSelected && state === "unauthenticated" ? "unauthenticated" : "authenticated",
        },
        availability: isSelected && state === "unavailable" ? "unavailable" : "available",
        version: null,
        checkedAt: "1970-01-01T00:00:00Z",
        models: [],
        slashCommands: [],
        skills: [],
        ...(isSelected && state === "exhausted"
          ? {
              usageLimits: {
                checkedAt: "1970-01-01T00:00:00Z",
                windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
              },
            }
          : {}),
      };
      return [
        {
          instanceId,
          snapshot: { getSnapshot: Effect.succeed(snapshot) },
          textGeneration: {
            generateReviewGuide: (request: TextGeneration.ReviewGuideGenerationInput) =>
              Effect.sync(() => {
                calls.push(request.modelSelection);
                return { overview: "Fix login", sections: [] };
              }).pipe(
                Effect.filterOrFail(
                  () => !(state === "failed" && isSelected),
                  () =>
                    new TextGenerationError({
                      operation: "generateReviewGuide",
                      detail: "Selected agent failed.",
                    }),
                ),
              ),
          },
        } as unknown as ProviderInstance,
      ];
    });
    const fixture = makeService(
      {
        textGenerators: state === "generator" ? generators : {},
        providerInstances: Object.fromEntries(
          [helper, alternate]
            .filter((id) => state !== "removed" || id !== helper)
            .map((id) => [
              id,
              {
                driver: ProviderDriverKind.make("codex"),
                config: {},
                enabled: id !== helper || state !== "disabled",
              },
            ]),
        ),
        projectSettingsOverrides: {
          [projectId]: {
            textGenerationModelSelection: selected,
            reviewGuideModelSelection: selected,
          },
        },
      },
      instances,
    );
    const service = yield* fixture.service;
    const result = yield* service
      .generateReviewGuide({
        ...input,
        number: 1,
        title: "Fix login",
        description: "",
        baseBranch: "main",
        baseCommit: "base",
        settledReview: "",
      })
      .pipe(Effect.result);
    expect(result._tag).toBe(state === "ready" ? "Success" : "Failure");
    expect(calls).toEqual(state === "ready" || state === "failed" ? [selected] : []);
  }),
);
