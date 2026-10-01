import { describe, expect, test } from "bun:test";
import type { WatchdogSettings } from "@findr/types/settings";
import { AttemptFailure, CancelledError } from "../pipeline/errors";
import type { AddOptions, Downloader, TorrentFile, TorrentInput, TorrentStatus } from "./Downloader";
import { FileInspector } from "./FileInspector";
import { TorrentSession } from "./TorrentSession";
import { Watchdog } from "./Watchdog";

const GB = 1024 ** 3;
const MINUTE = 60_000;

/** Builds a file list from `[path, sizeBytes]` pairs. */
function files(...entries: Array<[string, number]>): TorrentFile[] {
  return entries.map(([path, sizeBytes], index) => ({ index, path, sizeBytes }));
}

// ---------- FileInspector ---------- //

describe("FileInspector", () => {
  const inspector = new FileInspector();

  test("rejects torrents containing executables, wherever they are", () => {
    const result = inspector.inspect(
      files(["Movie/Movie.mkv", 4 * GB], ["Movie/Extras/Codec.Installer.EXE", 1_000_000]),
      { kind: "movie" },
    );
    expect(result).toEqual({ accepted: false, reason: "Contains a blocked file type: Codec.Installer.EXE" });
  });

  test("rejects archive-only releases", () => {
    const result = inspector.inspect(files(["Movie.rar", 4 * GB], ["Movie.r00", 4 * GB]), { kind: "movie" });
    expect(result).toEqual({ accepted: false, reason: "Archive-only release with no video file" });
  });

  test("picks the feature and skips samples and extras", () => {
    const result = inspector.inspect(
      files(["M/Sample/m-sample.mkv", 50_000_000], ["M/M.mkv", 4 * GB], ["M/M.nfo", 1000], ["M/Featurette.mkv", 300_000_000]),
      { kind: "movie" },
    );
    expect(result).toEqual({ accepted: true, files: [{ index: 1, path: "M/M.mkv", episodes: [] }] });
  });

  test("rejects a movie whose largest video is tiny", () => {
    const result = inspector.inspect(files(["Movie.mkv", 20_000_000]), { kind: "movie" });
    expect(result.accepted).toBe(false);
  });

  test("accepts a season pack only when every required episode is present", () => {
    const pack = files(
      ["Show.S01/Show.S01E01.1080p.mkv", GB],
      ["Show.S01/Show.S01E02.1080p.mkv", GB],
      ["Show.S01/Show.S01E03.1080p.mkv", GB],
    );
    const complete = inspector.inspect(pack, { kind: "season", season: 1, requiredEpisodes: [1, 2, 3] });
    expect(complete.accepted && complete.files.map((file) => file.episodes)).toEqual([[1], [2], [3]]);

    const incomplete = inspector.inspect(pack, { kind: "season", season: 1, requiredEpisodes: [1, 2, 3, 4, 5] });
    expect(incomplete).toEqual({ accepted: false, reason: "Incomplete season pack: missing E04, E05" });
  });

  test("keeps one selection for a file covering several episodes", () => {
    const result = inspector.inspect(
      files(["Show.S01E01E02.mkv", 2 * GB], ["Show.S01E03.mkv", GB]),
      { kind: "season", season: 1, requiredEpisodes: [1, 2, 3] },
    );
    expect(result.accepted && result.files).toEqual([
      { index: 0, path: "Show.S01E01E02.mkv", episodes: [1, 2] },
      { index: 1, path: "Show.S01E03.mkv", episodes: [3] },
    ]);
  });

  test("ignores files from other seasons in a pack", () => {
    const result = inspector.inspect(
      files(["Show.S02E01.mkv", GB], ["Show.S01E01.mkv", GB]),
      { kind: "season", season: 1, requiredEpisodes: [1] },
    );
    expect(result.accepted && result.files[0]?.path).toBe("Show.S01E01.mkv");
  });

  test("an episode release with one unnamed video is that episode", () => {
    const result = inspector.inspect(files(["video.mkv", GB]), { kind: "episode", season: 1, episode: 4 });
    expect(result).toEqual({ accepted: true, files: [{ index: 0, path: "video.mkv", episodes: [4] }] });
  });
});

// ---------- Watchdog ---------- //

describe("Watchdog", () => {
  const settings: WatchdogSettings = {
    metadataTimeoutMinutes: 5,
    stallTimeoutMinutes: 10,
    minSpeedKBps: 50,
    speedWindowMinutes: 10,
    pollIntervalSeconds: 5,
  };

  test("trips when metadata never arrives", () => {
    const watchdog = new Watchdog(settings, 0);
    expect(watchdog.check({ at: 4 * MINUTE, phase: "metadata", downloadedBytes: 0 })).toBeNull();
    expect(watchdog.check({ at: 6 * MINUTE, phase: "metadata", downloadedBytes: 0 })).toContain("No metadata");
  });

  test("trips on a stall, and any new byte resets the stall clock", () => {
    const watchdog = new Watchdog({ ...settings, minSpeedKBps: 0 }, 0);
    watchdog.check({ at: 0, phase: "downloading", downloadedBytes: 0 });
    expect(watchdog.check({ at: 9 * MINUTE, phase: "downloading", downloadedBytes: 1 })).toBeNull();
    expect(watchdog.check({ at: 18 * MINUTE, phase: "downloading", downloadedBytes: 1 })).toBeNull();
    expect(watchdog.check({ at: 20 * MINUTE, phase: "downloading", downloadedBytes: 1 })).toContain("Stalled");
  });

  test("judges speed only over a full window", () => {
    const watchdog = new Watchdog(settings, 0);
    const kbps = (rate: number, minutes: number) => rate * 1024 * minutes * 60;

    // 10 KB/s — far below the floor, but no verdict until the window has elapsed
    for (let minute = 0; minute < 10; minute++) {
      expect(watchdog.check({ at: minute * MINUTE, phase: "downloading", downloadedBytes: kbps(10, minute) })).toBeNull();
    }
    expect(watchdog.check({ at: 10 * MINUTE, phase: "downloading", downloadedBytes: kbps(10, 10) })).toContain("Too slow");
  });

  test("a healthy download never trips", () => {
    const watchdog = new Watchdog(settings, 0);
    for (let minute = 0; minute <= 30; minute++) {
      const bytes = 500 * 1024 * minute * 60;
      expect(watchdog.check({ at: minute * MINUTE, phase: "downloading", downloadedBytes: bytes })).toBeNull();
    }
  });
});

// ---------- TorrentSession ---------- //

/**
 * In-memory downloader. Metadata appears after `metadataPolls` calls to
 * `files`, and each `status` call advances the transfer by `step` of the
 * selected size until complete.
 */
class FakeDownloader implements Downloader {
  public started: number[] | null = null;
  public removed = false;
  public stopped = false;
  private polls = 0;
  private downloaded = 0;

  constructor(
    private readonly fileList: TorrentFile[],
    private readonly options: { metadataPolls?: number; step?: number } = {},
  ) {}

  public async add(_input: TorrentInput, _options: AddOptions): Promise<string> {
    return "hash";
  }

  public async files(): Promise<TorrentFile[] | null> {
    return this.polls++ >= (this.options.metadataPolls ?? 0) ? this.fileList : null;
  }

  public async start(_handle: string, indexes: number[]): Promise<void> {
    this.started = indexes;
  }

  public async status(): Promise<TorrentStatus> {
    const total = this.fileList
      .filter((file) => this.started?.includes(file.index))
      .reduce((sum, file) => sum + file.sizeBytes, 0);
    this.downloaded = Math.min(total, this.downloaded + total * (this.options.step ?? 0.5));
    const progress = total === 0 ? 0 : this.downloaded / total;
    return {
      state: progress >= 1 ? "complete" : "downloading",
      downloadedBytes: this.downloaded,
      totalBytes: total,
      progress,
      speedBytesPerSecond: 0,
      peers: 1,
    };
  }

  public async stop(): Promise<void> {
    this.stopped = true;
  }

  public async remove(): Promise<void> {
    this.removed = true;
  }

  public async managed(): Promise<Map<string, string>> {
    return new Map();
  }
}

describe("TorrentSession", () => {
  const fast: WatchdogSettings = {
    metadataTimeoutMinutes: 1,
    stallTimeoutMinutes: 1,
    minSpeedKBps: 0,
    speedWindowMinutes: 1,
    pollIntervalSeconds: 0.001,
  };

  /** Runs a session against a fake downloader with no-op callbacks. */
  function run(downloader: FakeDownloader, signal = new AbortController().signal) {
    const session = new TorrentSession(downloader, new FileInspector(), fast);
    const progress: number[] = [];
    const fetched = session.fetch({
      input: { kind: "magnet", uri: "magnet:?xt=urn:btih:hash" },
      directory: "/downloads/d/c/payload",
      tag: "findr-test",
      target: { kind: "movie" },
      signal,
      onDownloadStart: () => undefined,
      onProgress: (value) => progress.push(value),
    });
    return { session, fetched, progress };
  }

  test("waits for metadata, downloads only the selected file, then stops it", async () => {
    const downloader = new FakeDownloader(files(["M/M.mkv", 4 * GB], ["M/sample.mkv", 1000]), { metadataPolls: 2 });
    const { fetched, progress } = run(downloader);

    expect(await fetched).toEqual([
      { index: 0, path: "M/M.mkv", episodes: [], absolutePath: "/downloads/d/c/payload/M/M.mkv" },
    ]);
    expect(downloader.started).toEqual([0]);
    expect(downloader.stopped).toBe(true);
    expect(progress.at(-1)).toBe(1);
  });

  test("rejects a dangerous torrent before starting it, and discard removes it", async () => {
    const downloader = new FakeDownloader(files(["M/M.mkv", 4 * GB], ["M/setup.exe", 1000]));
    const { session, fetched } = run(downloader);

    await expect(fetched).rejects.toBeInstanceOf(AttemptFailure);
    await fetched.catch(() => undefined);
    expect(downloader.started).toBeNull();

    await session.discard();
    expect(downloader.removed).toBe(true);
  });

  test("stops promptly when cancelled", async () => {
    const controller = new AbortController();
    const downloader = new FakeDownloader(files(["M/M.mkv", 4 * GB]), { step: 0 });
    const { fetched } = run(downloader, controller.signal);

    setTimeout(() => controller.abort(), 20);
    await expect(fetched).rejects.toBeInstanceOf(CancelledError);
  });
});
