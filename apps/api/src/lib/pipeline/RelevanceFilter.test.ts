import { afterEach, describe, expect, test } from "bun:test";
import { LlmFilterSettingsSchema } from "@findr/types/settings";
import { env } from "../env/Env";
import { RelevanceFilter } from "./RelevanceFilter";

const realFetch = globalThis.fetch;
const settings = LlmFilterSettingsSchema.parse({ timeoutSeconds: 1 });
const context = { mediaType: "movie" as const, name: "Alien", year: 1979, overview: "A crew.", season: null };
const candidates = [
  { id: "a", title: "Alien.1979.1080p.BluRay.x264" },
  { id: "b", title: "Aliens.1986.1080p.BluRay.x264" },
  { id: "c", title: "Alien.Romulus.2024.1080p.WEB-DL" },
];

/** Answers every Messages API call with the given response, recording request bodies. */
function mockApi(respond: () => Response): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return respond();
    },
    { preconnect: realFetch.preconnect },
  );
  return bodies;
}

/** A structured-output answer dropping the given short ids. */
function answer(drop: Array<{ id: string; reason: string }>, stopReason = "end_turn"): Response {
  return Response.json({ stop_reason: stopReason, content: [{ type: "text", text: JSON.stringify({ drop }) }] });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  env.ANTHROPIC_API_KEY = undefined;
});

describe("RelevanceFilter", () => {
  test("is inactive without an API key, and passes everything through", async () => {
    const bodies = mockApi(() => answer([{ id: "r1", reason: "x" }]));
    const drops = await new RelevanceFilter(settings).screen(context, candidates);
    expect(drops.size).toBe(0);
    expect(bodies).toHaveLength(0);
  });

  test("maps the model's short ids back to candidate ids and ignores invented ones", async () => {
    env.ANTHROPIC_API_KEY = "test-key";
    const bodies = mockApi(() =>
      answer([
        { id: "r2", reason: "Sequel" },
        { id: "r3", reason: "Different film" },
        { id: "r99", reason: "Hallucinated" },
      ]),
    );

    const drops = await new RelevanceFilter(settings).screen(context, candidates);

    expect([...drops.entries()]).toEqual([
      ["b", "Sequel"],
      ["c", "Different film"],
    ]);
    expect(bodies[0]).toMatchObject({ model: "claude-haiku-4-5", output_config: { format: { type: "json_schema" } } });
  });

  test("fails open on API errors, refusals, and answers that drop everything", async () => {
    env.ANTHROPIC_API_KEY = "test-key";
    const filter = new RelevanceFilter(settings);

    mockApi(() => new Response("overloaded", { status: 529 }));
    expect((await filter.screen(context, candidates)).size).toBe(0);

    mockApi(() => answer([{ id: "r1", reason: "x" }], "refusal"));
    expect((await filter.screen(context, candidates)).size).toBe(0);

    mockApi(() => answer(["r1", "r2", "r3"].map((id) => ({ id, reason: "x" }))));
    expect((await filter.screen(context, candidates)).size).toBe(0);
  });

  test("sends at most maxCandidates releases", async () => {
    env.ANTHROPIC_API_KEY = "test-key";
    const bodies = mockApi(() => answer([]));
    await new RelevanceFilter({ ...settings, maxCandidates: 2 }).screen(context, candidates);

    const message = (bodies[0]?.messages as Array<{ content: string }>)[0]?.content ?? "";
    expect(message).toContain("r2");
    expect(message).not.toContain("r3");
  });
});
