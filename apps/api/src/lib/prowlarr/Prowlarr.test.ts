import { afterEach, describe, expect, test } from "bun:test";
import Prowlarr from "./Prowlarr";

const KEY = "test-prowlarr-key";
const realFetch = globalThis.fetch;

/** Replaces fetch for one test, recording every URL requested. */
function mockFetch(respond: (url: URL) => Response): URL[] {
  const requested: URL[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requested.push(url);
      return respond(url);
    },
    { preconnect: realFetch.preconnect },
  );
  return requested;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Prowlarr", () => {
  test("strips the API key from every link it returns", async () => {
    mockFetch(() =>
      Response.json([
        {
          title: "Movie.2024.1080p.WEB-DL.x264-GRP",
          size: 4 * 1024 ** 3,
          seeders: 50,
          leechers: 3,
          indexer: "Idx",
          protocol: "torrent",
          // Prowlarr puts a proxy link in both fields, on its own hostname
          magnetUrl: `http://prowlarr:9696/1/download?apikey=${KEY}&link=abc&file=Movie`,
          downloadUrl: `http://prowlarr:9696/1/download?apikey=${KEY}&link=def&file=Movie`,
        },
      ]),
    );

    const [release] = await Prowlarr.getInstance().search({ name: "Movie", year: 2024, imdbId: "tt1", type: "movie" });

    expect(JSON.stringify(release)).not.toContain(KEY);
    expect(release?.magnetUri).toBeNull();
    expect(release?.downloadUrl).toBe("prowlarr:/1/download?link=def&file=Movie");
  });

  test("re-attaches the key only against the configured Prowlarr when fetching", async () => {
    const requested = mockFetch(
      () => new Response(null, { status: 302, headers: { location: "magnet:?xt=urn:btih:abc" } }),
    );

    const input = await Prowlarr.getInstance().resolveTorrent({
      magnetUri: null,
      infoHash: null,
      downloadUrl: "prowlarr:/1/download?link=def&file=Movie",
    });

    expect(input).toEqual({ kind: "magnet", uri: "magnet:?xt=urn:btih:abc" });
    expect(requested[0]?.origin).toBe("http://prowlarr.test:9696");
    expect(requested[0]?.searchParams.get("apikey")).toBe(KEY);
  });

  test("never sends the key to third-party links", async () => {
    const requested = mockFetch(() => new Response(new Uint8Array([0x64, 0x65]), { status: 200 }));

    const input = await Prowlarr.getInstance().resolveTorrent({
      magnetUri: null,
      infoHash: null,
      downloadUrl: "https://tracker.example/t/123.torrent",
    });

    expect(input.kind).toBe("file");
    expect(requested[0]?.searchParams.has("apikey")).toBe(false);
  });

  test("falls back to the info hash when the torrent file cannot be fetched", async () => {
    mockFetch(() => new Response("gone", { status: 404 }));

    const input = await Prowlarr.getInstance().resolveTorrent({
      magnetUri: null,
      infoHash: "abc123",
      downloadUrl: "prowlarr:/1/download?link=x",
    });

    expect(input).toEqual({ kind: "magnet", uri: "magnet:?xt=urn:btih:abc123" });
  });

  test("falls back to a text search when the id search finds nothing", async () => {
    const requested = mockFetch(() => Response.json([]));
    await Prowlarr.getInstance().search({ name: "Show", year: 2020, imdbId: "tt2", type: "tv", season: 2 });

    expect(requested.map((url) => url.searchParams.get("query"))).toEqual([
      "{ImdbId:tt2} {Season:2}",
      "Show {Season:2}",
    ]);
  });
});
