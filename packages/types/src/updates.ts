/**
 * Findr's own updates, for `/api/updates`. New versions are published as
 * GitHub releases. A standalone executable can install one itself; a source
 * checkout or a container is told about it and updated by hand. Automatic installs are
 * configured in the `updates` settings section.
 */

/**
 * `binary` is a compiled standalone executable; `source` runs from a checkout
 * with `bun`; `docker` runs in a container, updated by pulling a new image.
 */
export type InstallKind = "binary" | "source" | "docker";

/** The newest published release. */
export interface UpdateRelease {
  /** Semantic version, without the tag's leading `v`. */
  version: string;
  /** The release's page on GitHub. */
  url: string;
  /** The release notes, as Markdown. */
  notes: string;
  /** ISO timestamp, when GitHub reports one. */
  publishedAt: string | null;
}

/**
 * Why an available update cannot be installed from Findr right now.
 *
 * `source_install` — running from a checkout, which is updated by hand.
 * `docker_install` — running in a container, updated by pulling a new image.
 * `no_asset` — the release has no executable for this platform.
 * `not_writable` — the executable's directory cannot be written to.
 * `downloads_active` — downloads are queued or running; a restart would interrupt them.
 */
export type UpdateBlock = "source_install" | "docker_install" | "no_asset" | "not_writable" | "downloads_active";

/** `downloading` fetches the new executable; `restarting` swaps it in and starts it. */
export type UpdatePhase = "idle" | "downloading" | "restarting";

/** What the updater knows. */
export interface UpdateStatus {
  /** The running version. */
  current: string;
  install: InstallKind;
  /** The newest release seen, whether or not it is newer. Null before the first successful check. */
  latest: UpdateRelease | null;
  /** Whether `latest` is newer than `current`. */
  available: boolean;
  /** When GitHub last answered, in epoch milliseconds. */
  checkedAt: number | null;
  phase: UpdatePhase;
  /** Why the available update cannot be installed now. Null when it can, or when there is none. */
  blocked: UpdateBlock | null;
  /** Why the last check or install failed. Cleared by the next success. */
  error: string | null;
}
