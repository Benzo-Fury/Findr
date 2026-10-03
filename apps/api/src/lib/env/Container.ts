/**
 * Whether Findr is running inside a container (Docker, Podman). A container
 * is updated by pulling a new image and recreating it, never by replacing the
 * executable inside, which the next recreate would throw away.
 */

import { existsSync } from "node:fs";
import { env } from "./Env";

/** Files container runtimes place at the root of every container: Docker's and Podman's. */
const MARKERS = ["/.dockerenv", "/run/.containerenv"];

/**
 * Detects a container once per process. `FINDR_CONTAINER` decides when it is
 * set, so an image can declare itself and an unusual runtime can be named
 * either way; otherwise the runtimes' marker files are looked for.
 */
export class Container {
  private static detected: boolean | null = null;

  /** Whether this process runs in a container. */
  public static get inside(): boolean {
    this.detected ??= Container.detect(env.FINDR_CONTAINER, (path) => existsSync(path));
    return this.detected;
  }

  /** The decision itself, separated from the real environment and filesystem for tests. */
  public static detect(declared: boolean | undefined, exists: (path: string) => boolean): boolean {
    return declared ?? MARKERS.some(exists);
  }
}
