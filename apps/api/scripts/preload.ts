/**
 * Runtime preload for development and tests (see `bunfig.toml`). Registers
 * the native-addon stubs before any module is imported, so `bun run` and
 * `bun test` load WebTorrent exactly as the production build does.
 */

import { nativeStubsForRuntime } from "./native-stubs";

Bun.plugin(nativeStubsForRuntime);
