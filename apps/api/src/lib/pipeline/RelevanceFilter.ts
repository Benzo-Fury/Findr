/**
 * Optional LLM pass that removes releases which are clearly for the wrong
 * title — a similarly named film, a sequel, a spin-off, a making-of — before
 * any of them is downloaded. Scoring cannot catch these: they are often
 * well-seeded, well-encoded releases of the wrong thing.
 *
 * It fails open by design. With no API key, a disabled setting, an error, a
 * refusal, a timeout or an unparseable answer, every candidate passes through
 * untouched. The filter can only ever narrow the list, never block a download.
 */

import type { LlmFilterSettings } from "@findr/types/settings";

// ---------- Types ---------- //

/** What the model is told about the title being searched for. */
export interface RelevanceContext {
  mediaType: "movie" | "tv";
  name: string;
  year: number | null;
  overview: string;
  season: number | null;
}

/** A release the filter judges, identified by the caller's own id. */
export interface RelevanceCandidate {
  id: string;
  title: string;
}

/** Releases to drop, keyed by candidate id, with the model's reason. */
export type Drops = Map<string, string>;

/** The fields of a Messages API response the filter reads. */
interface MessagesResponse {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
}

/** The structured answer the model is constrained to. */
interface FilterAnswer {
  drop: Array<{ id: string; reason: string }>;
}

// ---------- Constants ---------- //

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** JSON schema for structured output — every object closed, per the API's requirements. */
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    drop: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, reason: { type: "string" } },
        required: ["id", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["drop"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You screen torrent release titles for a self-hosted media downloader. You are given the movie or TV show the user asked for and a list of candidate release titles found by indexer search.

Drop a release only when its title clearly refers to something other than what was asked for: a different film or show with a similar name, a sequel, prequel, remake or spin-off, a different year's production of the same name, a documentary or making-of about it, a soundtrack, a game, or a compilation of unrelated content. For TV, also drop releases for a clearly different show.

Keep a release whenever you are unsure. Do not judge quality, resolution, codec, size, language or release group — other checks handle those. Release titles use dots or spaces for word breaks and often abbreviate; a release that plausibly matches should be kept.`;

// ---------- Filter ---------- //

export class RelevanceFilter {
  /** Takes the filter's settings and the Anthropic key from the services settings; an empty key disables it. */
  constructor(
    private readonly settings: LlmFilterSettings,
    private readonly apiKey: string,
  ) {}

  /** Whether the filter will run at all: enabled in settings and an API key set. */
  public get active(): boolean {
    return this.settings.enabled && this.apiKey !== "";
  }

  /**
   * Returns the candidates to drop. Only the first `maxCandidates` are sent —
   * pass them best-first. Anything that goes wrong yields an empty result.
   */
  public async screen(context: RelevanceContext, candidates: RelevanceCandidate[]): Promise<Drops> {
    const drops: Drops = new Map();
    if (!this.active || candidates.length === 0) return drops;

    // Short positional ids keep the prompt small and the answer unambiguous
    const screened = candidates.slice(0, this.settings.maxCandidates);
    const byShortId = new Map(screened.map((candidate, index) => [`r${index + 1}`, candidate.id]));

    try {
      const answer = await this.ask(context, screened.map((candidate, index) => ({ id: `r${index + 1}`, title: candidate.title })));

      // Map the model's short ids back, ignoring any it invented
      for (const { id, reason } of answer?.drop ?? []) {
        const candidateId = byShortId.get(id);
        if (candidateId) drops.set(candidateId, reason);
      }

      // A filter that would reject everything is more likely wrong than right
      if (drops.size === screened.length) {
        console.warn("[RelevanceFilter] Model dropped every candidate; ignoring its answer");
        return new Map();
      }
    } catch (error) {
      console.warn("[RelevanceFilter] Skipped:", error instanceof Error ? error.message : error);
      return new Map();
    }

    return drops;
  }

  /** Calls the Messages API with a structured-output schema. Null when the answer is unusable. */
  private async ask(context: RelevanceContext, releases: Array<{ id: string; title: string }>): Promise<FilterAnswer | null> {
    const wanted = {
      type: context.mediaType === "tv" ? "TV show" : "movie",
      name: context.name,
      year: context.year,
      ...(context.season !== null ? { season: context.season } : {}),
      overview: context.overview,
    };

    const response = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.settings.model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: ANSWER_SCHEMA } },
        messages: [
          {
            role: "user",
            content: `Requested:\n${JSON.stringify(wanted, null, 2)}\n\nCandidate releases:\n${JSON.stringify(releases, null, 2)}\n\nList the releases to drop, with a short reason for each. Return an empty list if every release matches.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(this.settings.timeoutSeconds * 1000),
    });

    if (!response.ok) throw new Error(`Anthropic API responded with ${response.status}`);

    // Refusals and truncated output may not match the schema — treat as no answer
    const body = (await response.json()) as MessagesResponse;
    if (body.stop_reason !== "end_turn") throw new Error(`Unusable answer (stop_reason ${body.stop_reason})`);

    const text = body.content?.find((block) => block.type === "text")?.text;
    return text ? (JSON.parse(text) as FilterAnswer) : null;
  }
}
