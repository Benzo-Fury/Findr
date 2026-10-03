/**
 * Keeps Findr up to date. Asks GitHub for the latest release at startup and
 * every few hours, and reports whether it is newer than the running version.
 *
 * A standalone executable can install it: the release's executable for this
 * platform is downloaded beside the running one, checked against the
 * release's `SHA256SUMS.txt`, renamed over it, and started in place of this
 * process. Settings and data live outside the executable, so they carry over.
 * A source checkout is only told about the release; it updates with git. So
 * is a container, whose image is pulled anew instead: a swapped executable
 * would be lost the next time the container is recreated.
 *
 * A restart would interrupt transfers and reject good releases, so installing
 * is refused while any download is queued or running, and the queue is held
 * while the new executable downloads. With `updates.autoInstall` on, a new
 * release installs itself the first time the queue is empty.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { chmod, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { UpdateBlock, UpdatePhase, UpdateStatus } from "@findr/types/updates";
import { version as packageVersion } from "../../../../../package.json";
import { AppState } from "../db/models/AppState";
import { SettingsStore } from "../db/models/SettingsStore";
import { Container } from "../env/Container";
import { env } from "../env/Env";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import DownloadQueue from "../pipeline/DownloadQueue";

// ---------- Types ---------- //

/** The running installation, as the updater sees and changes it. Tests replace it. */
export interface UpdaterHost {
  /** The running version. */
  version: string;
  /** The compile target this executable was built for, such as `linux-x64`. Null when running from source. */
  target: string | null;
  /** Whether this runs in a container, which is updated by pulling a new image. */
  container: boolean;
  /** The running executable. */
  executable: string;
  /** The GitHub API URL of the latest release. */
  feedUrl: string;
  /** Starts the executable in place of this process. */
  restart(): void;
}

/** An install the updater refuses, with a code the API answers with. */
export class UpdateError extends Error {
  constructor(
    public readonly code: UpdateBlock | "no_update" | "update_in_progress",
    message: string,
  ) {
    super(message);
  }
}

// ---------- Schemas ---------- //

/** The fields of a GitHub release the updater reads. */
const GitHubReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  body: z.string().nullish(),
  published_at: z.string().nullish(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

/** A release as remembered, with each downloadable file's URL by name. */
const KnownReleaseSchema = z.object({
  version: z.string(),
  url: z.string(),
  notes: z.string(),
  publishedAt: z.string().nullable(),
  assets: z.record(z.string(), z.string()),
});
type KnownRelease = z.infer<typeof KnownReleaseSchema>;

/** The last answer from GitHub, kept in `app_state` so a restart remembers it and can ask conditionally. */
const LastCheckSchema = z.object({
  etag: z.string().nullable(),
  checkedAt: z.number(),
  release: KnownReleaseSchema.nullable(),
});
type LastCheck = z.infer<typeof LastCheckSchema>;

// ---------- Constants ---------- //

const STATE_KEY = "updates";
/** How often GitHub is asked, besides at startup. */
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** How often the updater wakes to see whether a check is due or an automatic install can go ahead. */
const TICK_MS = 60_000;
const CHECK_TIMEOUT_MS = 15_000;
/** The release file listing every executable's SHA-256. */
const CHECKSUMS_ASSET = "SHA256SUMS.txt";
/** The exit code systemd is told to restart on: a temporary failure. */
const EXIT_RESTART = 75;

/**
 * The real process. The build inlines `FINDR_VERSION`, the version it was
 * released under, and `FINDR_TARGET` into each compiled executable; running
 * from source, the version is the checkout's `package.json`.
 */
const SYSTEM_HOST: UpdaterHost = {
  version: process.env.FINDR_VERSION ?? packageVersion,
  target: process.env.FINDR_TARGET ?? null,
  container: Container.inside,
  executable: process.execPath,
  feedUrl: env.UPDATES_URL,
  restart: () => {
    // Under systemd the unit restarts on a failure exit; anywhere else a
    // detached replacement takes over with the same arguments and directory
    if (process.env.INVOCATION_ID) process.exit(EXIT_RESTART);
    spawn(process.execPath, process.argv.slice(2), { cwd: process.cwd(), env: process.env, detached: true, stdio: "inherit" }).unref();
    process.exit(0);
  },
};

// ---------- Updater ---------- //

export default class Updater extends SelfManagedSingleton {
  private host: UpdaterHost = SYSTEM_HOST;
  private phase: UpdatePhase = "idle";
  private error: string | null = null;
  /** A version whose install failed, so it is not retried automatically. */
  private failed: string | null = null;
  private checking: Promise<UpdateStatus> | null = null;
  /** When GitHub was last asked, whatever it answered. */
  private lastAsked = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Frees what the replacement process needs, such as the port. */
  private beforeRestart: () => Promise<void> | void = () => undefined;

  /** Swaps the installation the updater works on. Used by tests. */
  public useHost(host: UpdaterHost): this {
    this.host = host;
    this.phase = "idle";
    this.error = null;
    this.failed = null;
    this.lastAsked = 0;
    return this;
  }

  /**
   * Checks now and then on a timer, installing automatically when that is on.
   * `beforeRestart` runs just before this process hands over to a new version.
   */
  public start(beforeRestart: () => Promise<void> | void): void {
    this.beforeRestart = beforeRestart;
    void this.removeLeftovers();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  /** Stops the timer. */
  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What the updater knows right now. */
  public get status(): UpdateStatus {
    const last = this.lastCheck();
    const release = last?.release ?? null;
    const available = release !== null && isNewer(release.version, this.host.version);

    return {
      current: this.host.version,
      install: this.host.container ? "docker" : this.host.target ? "binary" : "source",
      latest: release && { version: release.version, url: release.url, notes: release.notes, publishedAt: release.publishedAt },
      available,
      checkedAt: last?.checkedAt ?? null,
      phase: this.phase,
      blocked: release && available && this.phase === "idle" ? this.blocker(release) : null,
      error: this.error,
    };
  }

  /** Asks GitHub for the latest release now. Concurrent calls share one request. */
  public check(): Promise<UpdateStatus> {
    this.checking ??= this.fetchLatest().finally(() => (this.checking = null));
    return this.checking;
  }

  /**
   * Starts installing the available update and answers at once; the download
   * runs in the background and ends with a restart. Throws `UpdateError` when
   * there is nothing to install or it cannot be installed now.
   */
  public install(): UpdateStatus {
    const release = this.lastCheck()?.release;
    if (this.phase !== "idle") throw new UpdateError("update_in_progress", "An update is already installing");
    if (!release || !isNewer(release.version, this.host.version)) throw new UpdateError("no_update", "Findr is up to date");
    const blocked = this.blocker(release);
    if (blocked) throw new UpdateError(blocked, `The update cannot be installed: ${blocked}`);

    // Nothing may start that the restart would interrupt
    const queue = DownloadQueue.getInstance();
    queue.hold();
    this.phase = "downloading";
    this.error = null;
    console.log(`[Updates] Installing ${release.version}`);

    this.replace(release).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[Updates] Could not install ${release.version}:`, reason);
      this.failed = release.version;
      this.error = `Could not install ${release.version}: ${reason}`;
      this.phase = "idle";
      queue.release();
    });
    return this.status;
  }

  // ---------- Checking ---------- //

  /** Runs a check when one is due, then installs automatically if that is on and nothing would be interrupted. */
  private async tick(): Promise<void> {
    if (Date.now() - this.lastAsked >= CHECK_INTERVAL_MS) await this.check();

    const status = this.status;
    const wanted = SettingsStore.section("updates").autoInstall && status.available && status.latest?.version !== this.failed;
    if (!wanted || status.blocked || status.phase !== "idle") return;
    try {
      this.install();
    } catch (error) {
      console.warn("[Updates] Automatic install did not start:", error instanceof Error ? error.message : error);
    }
  }

  /** Asks GitHub for the latest release, conditionally on the last answer, and remembers the result. */
  private async fetchLatest(): Promise<UpdateStatus> {
    this.lastAsked = Date.now();
    const last = this.lastCheck();

    try {
      const response = await fetch(this.host.feedUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Findr/${this.host.version}`,
          ...(last?.etag ? { "If-None-Match": last.etag } : {}),
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });

      // Unchanged since last time; a 304 does not count against GitHub's rate limit
      if (response.status === 304 && last) this.save({ ...last, checkedAt: Date.now() });
      // A repository with no releases yet
      else if (response.status === 404) this.save({ etag: null, checkedAt: Date.now(), release: null });
      else if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      else {
        const release = GitHubReleaseSchema.parse(await response.json());
        this.save({ etag: response.headers.get("etag"), checkedAt: Date.now(), release: knownRelease(release) });
      }
      this.error = null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn("[Updates] Could not check for updates:", reason);
      this.error = `Could not check for updates: ${reason}`;
    }
    return this.status;
  }

  // ---------- Installing ---------- //

  /** Why a release cannot be installed now, or null when it can. */
  private blocker(release: KnownRelease): UpdateBlock | null {
    if (this.host.container) return "docker_install";
    if (!this.host.target) return "source_install";
    if (!this.assetName(release)) return "no_asset";
    if (!isWritable(dirname(this.executable()))) return "not_writable";
    if (DownloadQueue.getInstance().busy) return "downloads_active";
    return null;
  }

  /** Downloads and verifies the release's executable, renames it over the running one, then restarts. */
  private async replace(release: KnownRelease): Promise<void> {
    const name = this.assetName(release);
    const url = name && release.assets[name];
    if (!name || !url) throw new Error("The release has no executable for this platform");

    const executable = this.executable();
    const download = `${executable}.download`;
    const previous = `${executable}.old`;

    try {
      // Fetch beside the executable, so the swap is a rename on one filesystem
      const response = await fetch(url);
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${name}`);
      await Bun.write(download, response);
      await verifyChecksum(download, name, release);
      await chmod(download, 0o755);

      // Windows cannot replace a running executable, but it can rename one;
      // the old copy is deleted on the next start
      if (process.platform === "win32") {
        await rm(previous, { force: true });
        await rename(executable, previous);
      }
      try {
        await rename(download, executable);
      } catch (error) {
        if (process.platform === "win32") await rename(previous, executable);
        throw error;
      }
    } catch (error) {
      await rm(download, { force: true });
      throw error;
    }

    this.phase = "restarting";
    console.log(`[Updates] Installed ${release.version}; restarting`);
    await this.beforeRestart();
    this.host.restart();
  }

  /** Deletes what an earlier install left beside the executable. */
  private async removeLeftovers(): Promise<void> {
    if (!this.host.target || this.host.container) return;
    const executable = this.executable();
    await Promise.all([rm(`${executable}.download`, { force: true }), rm(`${executable}.old`, { force: true })]).catch(() => undefined);
  }

  // ---------- Helpers ---------- //

  /** The release file built for this executable's target, if it has one. */
  private assetName(release: KnownRelease): string | null {
    const base = `findr-${this.host.target}`;
    return [base, `${base}.exe`].find((name) => name in release.assets) ?? null;
  }

  /** The running executable, with symlinks resolved so the swap replaces the real file. */
  private executable(): string {
    try {
      return realpathSync(this.host.executable);
    } catch {
      return this.host.executable;
    }
  }

  private lastCheck(): LastCheck | null {
    const parsed = LastCheckSchema.safeParse(AppState.get(STATE_KEY));
    return parsed.success ? parsed.data : null;
  }

  private save(check: LastCheck): void {
    AppState.set(STATE_KEY, check);
  }
}

// ---------- Functions ---------- //

/** A GitHub release in the shape the updater keeps. */
function knownRelease(release: z.infer<typeof GitHubReleaseSchema>): KnownRelease {
  return {
    version: release.tag_name.replace(/^v/i, ""),
    url: release.html_url,
    notes: release.body ?? "",
    publishedAt: release.published_at ?? null,
    assets: Object.fromEntries(release.assets.map((asset) => [asset.name, asset.browser_download_url])),
  };
}

/** Whether `candidate` is a later version than `current`. A tag that is not a version never is. */
function isNewer(candidate: string, current: string): boolean {
  try {
    return Bun.semver.order(candidate, current) === 1;
  } catch {
    return false;
  }
}

function isWritable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a downloaded file against the release's checksum list, which guards
 * against a truncated or corrupted download. Releases without one are trusted.
 */
async function verifyChecksum(path: string, name: string, release: KnownRelease): Promise<void> {
  const url = release.assets[CHECKSUMS_ASSET];
  if (!url) return;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${CHECKSUMS_ASSET}`);

  // Lines are `<hex digest>  <file name>`, the name starred in binary mode
  const expected = (await response.text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name || file === `*${name}`)?.[0];
  if (!expected) throw new Error(`${CHECKSUMS_ASSET} does not list ${name}`);

  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  if (hasher.digest("hex") !== expected.toLowerCase()) throw new Error(`The downloaded ${name} does not match its checksum`);
}
