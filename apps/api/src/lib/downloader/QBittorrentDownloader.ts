/**
 * `Downloader` backed by qBittorrent's Web API.
 *
 * Torrents are added so they fetch metadata and then wait: `.torrent` files
 * are added stopped (their file list is known immediately), and magnets use
 * qBittorrent's `MetadataReceived` stop condition, which fetches the file
 * list and halts before any payload arrives. Every torrent gets a shared
 * `findr` tag plus its own unique tag, which is how handles are recovered and
 * how leftovers are found after a crash.
 *
 * qBittorrent must see the same filesystem paths as Findr — the save
 * directory passed in is the one qBittorrent writes to.
 */

import { QBittorrent, TorrentFilePriority, type AddMagnetOptions } from "@ctrl/qbittorrent";
import { env } from "../env/Env";
import { AttemptFailure, FatalDownloadError } from "../pipeline/errors";
import type { AddOptions, Downloader, TorrentFile, TorrentInput, TorrentStatus } from "./Downloader";

// ---------- Constants ---------- //

/** Every torrent Findr adds carries this tag, alongside its own unique one. */
const MANAGED_TAG = "findr";

/** qBittorrent registers a new torrent asynchronously; wait this long for it to appear. */
const REGISTER_TIMEOUT_MS = 15_000;
const REGISTER_POLL_MS = 500;

/** States in which the selected payload is fully on disk. */
const COMPLETE_STATES = new Set([
  "uploading", "stalledUP", "pausedUP", "stoppedUP", "queuedUP", "forcedUP", "checkingUP",
]);
const ERROR_STATES = new Set(["error", "missingFiles"]);
const METADATA_STATES = new Set(["metaDL", "forcedMetaDL"]);

// ---------- Downloader ---------- //

export class QBittorrentDownloader implements Downloader {
  private readonly client: QBittorrent;

  /** Connects lazily; nothing is sent until the first call. */
  constructor() {
    this.client = new QBittorrent({
      baseUrl: env.QBT_URL,
      username: env.QBT_USERNAME ?? "",
      password: env.QBT_PASSWORD ?? "",
      timeout: 15_000,
    });
  }

  public async add(input: TorrentInput, options: AddOptions): Promise<string> {
    const common = {
      savepath: options.directory,
      tags: `${MANAGED_TAG},${options.tag}`,
      contentLayout: "Original" as const,
    };

    // Add so that the torrent stops before downloading any payload. The
    // client library forwards unknown options verbatim, which is how the stop
    // condition (qBittorrent 4.5+) reaches the API.
    await this.call("add the torrent", async () => {
      if (input.kind === "magnet") {
        const magnetOptions: Partial<AddMagnetOptions> & { stopCondition: string } = {
          ...common,
          stopCondition: "MetadataReceived",
        };
        await this.client.addMagnet(input.uri, magnetOptions);
      } else {
        await this.client.addTorrent(input.bytes, { ...common, paused: "true", stopped: "true" });
      }
    });

    return this.awaitRegistration(options.tag);
  }

  public async files(handle: string): Promise<TorrentFile[] | null> {
    const files = await this.call("list torrent files", () => this.client.torrentFiles(handle));

    // An empty list means the magnet has not resolved yet
    if (files.length === 0) return null;
    return files.map((file, index) => ({ index, path: file.name, sizeBytes: file.size }));
  }

  public async start(handle: string, fileIndexes: number[]): Promise<void> {
    const wanted = new Set(fileIndexes);
    const files = (await this.files(handle)) ?? [];
    const skipped = files.filter((file) => !wanted.has(file.index)).map((file) => String(file.index));

    // Deselect everything unwanted, then start transferring
    await this.call("select torrent files", async () => {
      if (skipped.length > 0) await this.client.setFilePriority(handle, skipped, TorrentFilePriority.Skip);
      await this.client.startTorrent(handle);
    });
  }

  public async status(handle: string): Promise<TorrentStatus | null> {
    const [torrent] = await this.call("read torrent status", () => this.client.listTorrents({ hashes: handle }));
    if (!torrent) return null;

    // Map qBittorrent's many states onto the four the pipeline cares about
    const state: TorrentStatus["state"] = ERROR_STATES.has(torrent.state)
      ? "error"
      : METADATA_STATES.has(torrent.state)
        ? "metadata"
        : COMPLETE_STATES.has(torrent.state) || torrent.progress >= 1
          ? "complete"
          : "downloading";

    return {
      state,
      downloadedBytes: torrent.completed,
      totalBytes: torrent.size,
      progress: torrent.progress,
      speedBytesPerSecond: torrent.dlspeed,
      seeds: torrent.num_seeds,
      ...(state === "error" ? { error: `qBittorrent reported ${torrent.state}` } : {}),
    };
  }

  public async stop(handle: string): Promise<void> {
    await this.call("stop the torrent", () => this.client.stopTorrent(handle));
  }

  public async remove(handle: string): Promise<void> {
    await this.call("remove the torrent", () => this.client.removeTorrent(handle, true));
  }

  public async managed(): Promise<Map<string, string>> {
    const torrents = await this.call("list managed torrents", () => this.client.listTorrents({ tag: MANAGED_TAG }));

    // Key each torrent by its unique tag
    const byTag = new Map<string, string>();
    for (const torrent of torrents) {
      const unique = torrent.tags
        .split(",")
        .map((tag) => tag.trim())
        .find((tag) => tag !== MANAGED_TAG && tag.length > 0);
      if (unique) byTag.set(unique, torrent.hash);
    }
    return byTag;
  }

  // ---------- Internals ---------- //

  /** Polls until the newly added torrent shows up under its tag, returning its hash. */
  private async awaitRegistration(tag: string): Promise<string> {
    const deadline = Date.now() + REGISTER_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const [torrent] = await this.call("find the added torrent", () => this.client.listTorrents({ tag }));
      if (torrent) return torrent.hash;
      await Bun.sleep(REGISTER_POLL_MS);
    }

    throw new AttemptFailure("qBittorrent accepted the torrent but never registered it");
  }

  /**
   * Runs a client call, translating failures. qBittorrent refusing a torrent
   * is the release's fault; anything else — refused connections, bad
   * credentials, timeouts — means the client itself is unusable.
   */
  private async call<T>(action: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // A rejected add is specific to this torrent (duplicate, corrupt file)
      if (message === "Failed to add torrent") {
        throw new AttemptFailure("qBittorrent refused the torrent (corrupt, or already in the client)");
      }
      throw new FatalDownloadError(`Could not ${action} — qBittorrent at ${env.QBT_URL} is unavailable: ${message}`);
    }
  }
}
