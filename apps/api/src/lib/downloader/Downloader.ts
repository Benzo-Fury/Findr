/**
 * The contract between the pipeline and a torrent client. The pipeline never
 * talks to the client directly — it drives this interface, so the backend
 * can be swapped (or faked in tests) without touching the attempt loop.
 *
 * The contract is built around inspecting before downloading: a torrent is
 * added so that it fetches its file list and then waits, the pipeline decides
 * which files it wants (or rejects the torrent outright), and only then is
 * the payload downloaded.
 */

// ---------- Inputs ---------- //

/** A torrent to add: a magnet link, or the bytes of a `.torrent` file. */
export type TorrentInput =
  | { kind: "magnet"; uri: string }
  | { kind: "file"; bytes: Uint8Array<ArrayBuffer> };

export interface AddOptions {
  /** Absolute directory the payload is saved under. */
  directory: string;
  /** Unique label for this attempt's torrent, used to find it again. */
  tag: string;
}

// ---------- Outputs ---------- //

/** One file inside a torrent, as the client reports it. */
export interface TorrentFile {
  /** The client's index for the file, used to select it. */
  index: number;
  /** Path relative to the save directory, including any top-level folder. */
  path: string;
  sizeBytes: number;
}

/**
 * A snapshot of a torrent's progress. Byte counts cover only the selected
 * files, so a torrent with unwanted extras still reaches 100%.
 */
export interface TorrentStatus {
  state: "metadata" | "downloading" | "complete" | "error";
  downloadedBytes: number;
  totalBytes: number;
  /** 0–1 over the selected files. */
  progress: number;
  speedBytesPerSecond: number;
  /** Peers currently connected. */
  peers: number;
  /** Set when `state` is `error`. */
  error?: string;
}

// ---------- Contract ---------- //

export interface Downloader {
  /** Adds a torrent without downloading its payload. Resolves to a handle for later calls. */
  add(input: TorrentInput, options: AddOptions): Promise<string>;

  /** The torrent's files, or null while its metadata is still being fetched. */
  files(handle: string): Promise<TorrentFile[] | null>;

  /** Restricts the download to the given file indexes and starts it. */
  start(handle: string, fileIndexes: number[]): Promise<void>;

  /** Current progress, or null when the torrent no longer exists in the client. */
  status(handle: string): Promise<TorrentStatus | null>;

  /** Stops transferring without removing anything, so files can be read safely. */
  stop(handle: string): Promise<void>;

  /** Removes the torrent and deletes its data from disk. Safe to call on a missing torrent. */
  remove(handle: string): Promise<void>;

  /** Handles of every torrent this app added that the client still holds, keyed by tag — swept at startup. */
  managed(): Promise<Map<string, string>>;

  /**
   * Cuts every network connection at once, for the VPN killswitch. Torrents
   * still transferring are destroyed with their data, and any later call on
   * one throws `SuspendedError` with the reason. Stopped torrents keep their
   * files, so an attempt already processing them can finish. Torrents added
   * afterwards start a fresh client.
   */
  disconnect(reason: string): Promise<void>;
}
