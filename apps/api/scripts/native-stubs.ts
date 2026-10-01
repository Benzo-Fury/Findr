/**
 * Replaces WebTorrent's optional native addons with pure-JS stubs. Used in
 * two places so every way of running Findr loads the same module graph:
 *
 * - the build (`scripts/build.ts`), as a `Bun.build` plugin, so the bundle
 *   and compiled binaries contain no native code and cross-compile cleanly;
 * - development and tests (`scripts/preload.ts`, wired in `bunfig.toml`), as
 *   a runtime plugin, since Bun does not run these packages' install scripts
 *   and their native files would otherwise be missing.
 *
 * None of the three is needed: Findr connects to peers over TCP only.
 */

import type { BunPlugin } from "bun";

/**
 * Each stub matches how its importer copes without the real module:
 *
 * - `webrtc-polyfill` — WebRTC peers (browser-only swarms). simple-peer treats
 *   undefined constructors as "no WebRTC support".
 * - `utp-native` — the uTP transport. It crashes Bun, and the client disables
 *   uTP anyway; WebTorrent only reads it when uTP is on.
 * - `fs-native-extensions` — sparse files and locking. random-access-file
 *   falls back to plain `fs` when loading it throws.
 */
export const NATIVE_STUBS: Record<string, string> = {
  "webrtc-polyfill": "export const RTCPeerConnection = undefined, RTCSessionDescription = undefined, RTCIceCandidate = undefined",
  "utp-native": "module.exports = {}",
  "fs-native-extensions": "throw new Error('fs-native-extensions is not loaded')",
};

/** Matches exactly the stubbed package names. */
const STUBBED = new RegExp(`^(${Object.keys(NATIVE_STUBS).join("|").replace(/-/g, "\\-")})$`);

/** For `Bun.build`: resolves each stubbed package to its stub source. */
export const nativeStubsForBuild: BunPlugin = {
  name: "native-stubs",
  setup(build) {
    build.onResolve({ filter: STUBBED }, (args) => ({ path: args.path, namespace: "native-stub" }));
    build.onLoad({ filter: /.*/, namespace: "native-stub" }, (args) => ({
      contents: NATIVE_STUBS[args.path] ?? "",
      loader: "js",
    }));
  },
};

/**
 * For `Bun.plugin` at runtime, where `onResolve` does not reach imports made
 * from inside `node_modules`: registers each stub as a virtual module instead.
 */
export const nativeStubsForRuntime: BunPlugin = {
  name: "native-stubs",
  setup(build) {
    for (const [name, contents] of Object.entries(NATIVE_STUBS)) {
      build.module(name, () => ({ contents, loader: "js" }));
    }
  },
};
