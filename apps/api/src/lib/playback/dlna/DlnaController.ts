/**
 * Findr as a DLNA control point. It finds renderers on the server's network
 * and on every connected cast bridge's, hands one a URL to play, and from then on is the remote: the web app sends
 * play, pause, seek, volume and stop through Findr, and Findr polls the
 * renderer for its state, saving the viewer's progress as it goes.
 *
 * Seeking a file served as it is goes to the renderer. A transport stream
 * can't be seeked by the renderer, so Findr loads it again from the new
 * position and remembers where that stream starts in the file.
 *
 * A renderer picked to cast to before anything plays shows Findr's splash, a
 * still photo, until something is played on it or it is unpicked.
 */

import type { PlaybackItemKey, RendererCommand, RendererPlay, RendererRecord, RendererState, RendererStatus } from "@findr/types/playback";
import SelfManagedSingleton from "../../other/SelfManagedSingleton";
import BridgeHub from "../bridge/BridgeHub";
import { CastAccess } from "../CastAccess";
import PlaybackService, { PlaybackError } from "../PlaybackService";
import { ProgressiveSession } from "../ProgressiveSession";
import { WatchHistory } from "../WatchHistory";
import { DlnaRenderer } from "./DlnaRenderer";
import { LocalRendererNetwork } from "./LocalRendererNetwork";
import type { RendererNetwork } from "./RendererNetwork";
import { Upnp, UpnpError } from "./Upnp";

/** A renderer Findr is driving. */
interface Active {
  renderer: DlnaRenderer;
  /** What was asked for, kept to load it again as a stream if the file won't play. */
  request: RendererPlay;
  session: ProgressiveSession;
  /** The stream's absolute URL, without a start time. */
  url: string;
  item: PlaybackItemKey;
  label: string;
  /** Where the loaded stream starts in the file; non-zero for a transport stream started part-way. */
  offsetMs: number;
  state: RendererState;
  positionMs: number;
  volume: number | null;
  muted: boolean;
  /** Polls in a row that got no answer. */
  failures: number;
  polls: number;
  lastReport: number;
  /** When it stopped, if it has; a renderer left stopped is let go. */
  stoppedAt: number | null;
  /** A command is in flight; polls wait so they don't read a half-changed state. */
  busy: boolean;
  /** When the current stream was loaded. */
  loadedAt: number;
  /** Whether the current stream has been seen playing, its position moving. */
  started: boolean;
  /**
   * The position the last poll read while it played but hadn't yet started,
   * or null. A TV can report the previous item's position as it opens a new
   * one, so only a position that moves forward counts as started.
   */
  lastPolledMs: number | null;
  /**
   * Where a file is still to be seeked to once it really plays, or null. Its
   * progress isn't read or saved until then, so an early position never
   * replaces the resume point.
   */
  resumeAt: number | null;
  timer: ReturnType<typeof setInterval>;
}

/** How often a driven renderer is asked for its state. */
const POLL_MS = 2000;

/** How often progress is saved while it plays. */
const REPORT_MS = 10_000;

/** Searches more often than this reuse the last result unless asked to refresh. */
const SEARCH_REUSE_MS = 30_000;

/** A renderer not seen in searches for this long is forgotten. */
const FORGET_MS = 10 * 60_000;

/** Unanswered polls before a renderer counts as gone. */
const MAX_FAILURES = 5;

/** A file the renderer took but hasn't started playing in this long is sent again as a stream. */
const DIRECT_START_MS = 15_000;

/** How long a file may take to really start before the resume seek gives up and the item is sent as a stream from there. */
const RESUME_WAIT_MS = 30_000;

/** A resume seek has landed once the position is this close to where it was aimed. */
const RESUME_TOLERANCE_MS = 10_000;

/** Resume seeks sent before giving up. */
const RESUME_TRIES = 3;

/** A renderer stopped for this long is let go, ending its session. */
const STOPPED_RELEASE_MS = 60_000;

/** The splash as DLNA names it: a JPEG up to 4096 pixels, sent whole rather than streamed. */
const SPLASH_PROTOCOL_INFO = "http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_LRG;DLNA.ORG_OP=00;DLNA.ORG_FLAGS=00900000000000000000000000000000";

export default class DlnaController extends SelfManagedSingleton {
  private readonly renderers = new Map<string, DlnaRenderer>();
  private readonly active = new Map<string, Active>();
  /** Renderers showing the splash, with the user who picked each. */
  private readonly splashes = new Map<string, string>();
  /** When each network was last searched, by network id. */
  private readonly lastSearch = new Map<string, number>();
  /** The search running on each network, by network id. */
  private readonly searching = new Map<string, Promise<void>>();

  // ---------- Discovery ---------- //

  /**
   * The renderers on every network that can be reached, searching again
   * where the last search is stale or `refresh` is set. Networks are searched
   * together, so a slow bridge holds up the answer only as long as its own
   * search may take.
   */
  public async list(refresh = false): Promise<RendererRecord[]> {
    const networks = [LocalRendererNetwork.instance, ...BridgeHub.getInstance().networks().filter((network) => network.connected)];
    const stale = networks.filter((network) => refresh || Date.now() - (this.lastSearch.get(network.id) ?? 0) > SEARCH_REUSE_MS);
    await Promise.all(stale.map((network) => this.search(network)));

    // A removed bridge's renderers go, unless one is still being driven
    const hub = BridgeHub.getInstance();
    for (const [id, renderer] of this.renderers) {
      if (!renderer.network.local && !hub.get(renderer.network.id) && !this.active.has(id)) this.renderers.delete(id);
    }

    return [...this.renderers.values()]
      .filter((renderer) => renderer.network.connected)
      .map((renderer) => renderer.toRecord())
      .sort((a, b) => a.name.localeCompare(b.name) || (a.place ?? "").localeCompare(b.place ?? ""));
  }

  /** How many renderers were last found on a network. */
  public countOn(networkId: string): number {
    return [...this.renderers.values()].filter((renderer) => renderer.network.id === networkId).length;
  }

  /** One search at a time on each network; callers during a search share it. */
  private search(network: RendererNetwork): Promise<void> {
    const running = this.searching.get(network.id);
    if (running) return running;
    const search = (async () => {
      try {
        const locations = await network.search();
        const ours = [...this.renderers.values()].filter((renderer) => renderer.network === network);
        const known = new Map(ours.map((renderer) => [renderer.location, renderer]));

        // Describe what is new; mark what answered again as seen
        await Promise.all(
          [...locations].map(async (location) => {
            const existing = known.get(location);
            if (existing) {
              existing.lastSeen = Date.now();
              return;
            }
            // One device answering badly mustn't hide the others
            const renderer = await DlnaRenderer.open(location, network).catch(() => null);
            if (renderer) this.renderers.set(renderer.id, renderer);
          }),
        );

        // Forget this network's renderers long gone, unless one is being driven
        for (const renderer of ours) {
          if (Date.now() - renderer.lastSeen > FORGET_MS && !this.active.has(renderer.id)) this.renderers.delete(renderer.id);
        }
        this.lastSearch.set(network.id, Date.now());
      } finally {
        this.searching.delete(network.id);
      }
    })();
    this.searching.set(network.id, search);
    return search;
  }

  // ---------- Playing ---------- //

  /** Plays a movie or episode on a renderer, replacing whatever Findr had it playing. */
  public async play(rendererId: string, request: RendererPlay, userId: string): Promise<RendererStatus> {
    const renderer = this.renderers.get(rendererId);
    if (!renderer?.network.connected) throw new PlaybackError("renderer_not_found", 404);
    const base = renderer.network.mediaBase();
    if (!base) throw new PlaybackError("cast_address_unknown", 503);

    await this.release(rendererId, false);
    this.splashes.delete(rendererId);
    const label = request.label || "Findr";
    const { session, url, offsetMs } = await this.start(renderer, request, userId, base, label);
    const startMs = session.positionMs;

    const active: Active = {
      renderer,
      request,
      session,
      url,
      item: { titleId: request.titleId, season: request.season, episode: request.episode },
      label,
      offsetMs,
      state: "loading",
      positionMs: startMs,
      volume: null,
      muted: false,
      failures: 0,
      polls: 0,
      lastReport: Date.now(),
      stoppedAt: null,
      busy: false,
      loadedAt: Date.now(),
      started: false,
      lastPolledMs: null,
      resumeAt: session.direct && startMs > 0 ? startMs : null,
      timer: setInterval(() => void this.poll(rendererId), POLL_MS),
    };
    active.timer.unref?.();
    this.active.set(rendererId, active);
    if (active.resumeAt !== null) void this.resumeOnceStarted(rendererId, active, active.resumeAt);
    return this.status(rendererId, userId);
  }

  /** Carries out a command from the remote. */
  public async command(rendererId: string, command: RendererCommand, userId: string): Promise<RendererStatus> {
    const active = this.active.get(rendererId);
    const renderer = active?.renderer ?? this.renderers.get(rendererId);
    if (!renderer) throw new PlaybackError("renderer_not_found", 404);
    if (active && active.session.userId !== userId && command.action !== "volume" && command.action !== "mute") {
      // Anyone signed in may cast, but only the one who started this may drive it
      throw new PlaybackError("renderer_busy", 409);
    }

    if (active) active.busy = true;
    try {
      switch (command.action) {
        case "play":
          await renderer.play();
          if (active) active.state = "playing";
          break;
        case "pause":
          await renderer.pause();
          if (active) {
            active.state = "paused";
            this.report(active, "pause");
          }
          break;
        case "stop":
          if (active) this.report(active, "stop");
          await renderer.stop().catch(() => {});
          await this.release(rendererId, false);
          break;
        case "seek":
          // A seek from the remote replaces a resume still waiting
          if (active) active.resumeAt = null;
          if (active) await this.seek(active, command.positionMs);
          break;
        case "volume":
          await renderer.setVolume(command.volume);
          if (active) active.volume = command.volume;
          break;
        case "mute":
          await renderer.setMuted(command.muted);
          if (active) active.muted = command.muted;
          break;
      }
    } catch (error) {
      throw new PlaybackError("renderer_failed", 502, error instanceof Error ? error.message : String(error));
    } finally {
      if (active) active.busy = false;
    }
    return this.status(rendererId, userId);
  }

  /** What a renderer is doing, as far as Findr knows, and whether `userId` started it. */
  public status(rendererId: string, userId: string | null): RendererStatus {
    const active = this.active.get(rendererId);
    const renderer = active?.renderer ?? this.renderers.get(rendererId);
    if (!renderer) throw new PlaybackError("renderer_not_found", 404);
    return {
      renderer: renderer.toRecord(),
      state: active?.state ?? "idle",
      item: active?.item ?? null,
      label: active?.label ?? null,
      mine: active !== undefined && active.session.userId === userId,
      positionMs: active?.positionMs ?? 0,
      durationMs: active?.session.item.durationMs ?? 0,
      volume: active?.volume ?? null,
      muted: active?.muted ?? false,
      mode: active ? (active.session.direct ? "direct" : active.session.plan.mode) : null,
    };
  }

  /** The renderers playing something a user started, so the web app can lead back to their remotes. */
  public castsOf(userId: string): RendererStatus[] {
    return [...this.active]
      .filter(([, active]) => active.session.userId === userId)
      .map(([rendererId]) => this.status(rendererId, userId))
      .sort((a, b) => a.renderer.name.localeCompare(b.renderer.name));
  }

  // ---------- Splash ---------- //

  /**
   * Shows the splash on a renderer picked to cast to. Left alone when it
   * already plays something from Findr or takes no photos; a renderer that
   * won't show it is no failure, since the splash is only a courtesy.
   */
  public async showSplash(rendererId: string, userId: string): Promise<void> {
    const renderer = this.renderers.get(rendererId);
    if (!renderer?.network.connected) throw new PlaybackError("renderer_not_found", 404);
    const base = renderer.network.mediaBase();
    if (!base || this.active.has(rendererId) || !renderer.acceptsJpeg) return;

    const url = `${base}${CastAccess.SPLASH_PATH}`;
    try {
      await renderer.load(url, this.splashMetadata(url));
    } catch (error) {
      console.warn(`[Playback] ${renderer.name} didn't take the splash: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.splashes.set(rendererId, userId);
    // Some TVs show a photo as soon as it loads and refuse Play
    await renderer.play().catch(() => {});
  }

  /** Clears the splash the same user put up, unless something has started playing since. */
  public async hideSplash(rendererId: string, userId: string): Promise<void> {
    if (this.splashes.get(rendererId) !== userId) return;
    this.splashes.delete(rendererId);
    if (!this.active.has(rendererId)) await this.renderers.get(rendererId)?.stop().catch(() => {});
  }

  /** Stops every renderer Findr is driving, as when playback or casting is turned off. */
  public async stopAll(): Promise<void> {
    for (const [rendererId, userId] of [...this.splashes]) await this.hideSplash(rendererId, userId);
    for (const [rendererId, active] of [...this.active]) {
      this.report(active, "stop");
      await active.renderer.stop().catch(() => {});
      await this.release(rendererId, false);
    }
  }

  /**
   * Told by the playback service that a DLNA session ended, such as from the
   * admin's Now playing list: stop driving its renderer and stop the renderer.
   */
  public async released(sessionId: string): Promise<void> {
    for (const [rendererId, active] of this.active) {
      if (active.session.id !== sessionId) continue;
      clearInterval(active.timer);
      this.active.delete(rendererId);
      await active.renderer.stop().catch(() => {});
    }
  }

  // ---------- Inner workings ---------- //

  /**
   * Opens a session for what is asked, loads it on the renderer and starts
   * it, ending the session again if the renderer won't take it. A transport
   * stream starts where asked; a file starts at the top and is seeked once
   * it plays.
   */
  private async start(
    renderer: DlnaRenderer,
    request: RendererPlay,
    userId: string,
    base: string,
    label: string,
  ): Promise<{ session: ProgressiveSession; url: string; offsetMs: number }> {
    const service = PlaybackService.getInstance();
    const { session, path } = await service.createProgressive(
      request,
      {
        name: renderer.name,
        profile: renderer.profile,
        acceptsMatroska: renderer.acceptsMatroska,
        transportStreamType: renderer.transportStreamType,
        matroskaType: renderer.matroskaType,
        local: renderer.network.local,
      },
      userId,
    );
    const url = `${base}${path}`;
    const offsetMs = session.direct ? 0 : session.positionMs;
    try {
      await this.load(renderer, session, url, label, offsetMs);
    } catch (error) {
      await service.end(session.id, null);
      throw new PlaybackError("renderer_failed", 502, error instanceof Error ? error.message : String(error));
    }
    return { session, url, offsetMs };
  }

  /**
   * Sends a renderer that took the file but never played it the same item
   * as a transport stream, from where it was meant to start, and stops
   * offering it files. The remote keeps showing it as starting meanwhile.
   */
  private async fallBack(rendererId: string, active: Active): Promise<void> {
    const base = active.renderer.network.mediaBase();
    console.warn(`[Playback] ${active.renderer.name} took the file but didn't play it; sending a stream instead`);
    active.renderer.refuseMatroska();
    active.busy = true;
    const previous = active.session;
    try {
      if (!base) throw new Error("no address for TVs");
      const request = { ...active.request, startMs: active.positionMs };
      const next = await this.start(active.renderer, request, previous.userId, base, active.label);
      if (this.active.get(rendererId) !== active) {
        // Stopped meanwhile
        await PlaybackService.getInstance().end(next.session.id, null);
        return;
      }
      Object.assign(active, { session: next.session, url: next.url, offsetMs: next.offsetMs, loadedAt: Date.now(), started: false, lastPolledMs: null, resumeAt: null, stoppedAt: null });
      await PlaybackService.getInstance().end(previous.id, null);
    } catch (error) {
      console.warn(`[Playback] ${active.renderer.name} didn't take the stream either: ${error instanceof Error ? error.message : String(error)}`);
      active.state = "stopped";
      await this.release(rendererId, false);
    } finally {
      active.busy = false;
    }
  }

  /**
   * Loads a stream on the renderer and starts it. A Play that goes
   * unanswered isn't taken as a failure: some TVs start anyway, and polling
   * finds out either way.
   */
  private async load(renderer: DlnaRenderer, session: ProgressiveSession, url: string, label: string, offsetMs: number): Promise<void> {
    const streamUrl = session.direct ? url : `${url}?start=${offsetMs}`;
    await renderer.load(streamUrl, this.metadata(session, streamUrl, label, offsetMs));
    try {
      await renderer.play();
    } catch (error) {
      if (!(error instanceof UpnpError) || error.answered) throw error;
      console.warn(`[Playback] ${renderer.name} didn't answer Play; waiting to see whether it starts`);
    }
  }

  /** Seeks: on the renderer for a file, by reloading from there for a transport stream. */
  private async seek(active: Active, positionMs: number): Promise<void> {
    const target = Math.min(Math.max(positionMs, 0), Math.max(active.session.item.durationMs - 1000, 0));
    if (active.session.direct) await active.renderer.seek(target);
    else {
      await this.load(active.renderer, active.session, active.url, active.label, target);
      active.offsetMs = target;
    }
    active.positionMs = target;
    active.session.positionMs = target;
    this.report(active, "seek");
  }

  /**
   * Waits for a newly loaded file to really play, then seeks it to the
   * resume point and checks it got there. Some TVs report PLAYING, with a
   * stale position, while still opening the file, and quietly ignore a seek
   * sent then; so the seek waits for the position to move forward twice.
   * A file that never gets going, or won't seek, is sent as a stream from the
   * resume point instead. While the viewer has it paused the wait stands
   * still, so pausing early is never taken for a TV that won't start.
   */
  private async resumeOnceStarted(rendererId: string, active: Active, positionMs: number): Promise<void> {
    let deadline = Date.now() + RESUME_WAIT_MS;
    let last: number | null = null;
    let advancing = 0;
    let tries = 0;
    while (this.active.get(rendererId) === active && active.resumeAt !== null && Date.now() < deadline) {
      await Bun.sleep(500);
      if (active.busy) continue;
      const state = await active.renderer.state().catch(() => null);
      if (state === "paused") deadline = Date.now() + RESUME_WAIT_MS;
      const position = state === "playing" ? ((await active.renderer.position().catch(() => null))?.positionMs ?? null) : null;
      if (position === null) {
        last = null;
        advancing = 0;
        continue;
      }

      // Landed: hand over to polling
      if (tries > 0 && Math.abs(position - positionMs) < RESUME_TOLERANCE_MS) {
        active.resumeAt = null;
        active.started = true;
        return;
      }

      // Seek once it has moved forward twice, and again if it didn't take. TVs report whole
      // seconds, read here twice a second, so a repeated reading holds the count; going back resets it
      advancing = last === null || position < last ? 0 : position > last ? advancing + 1 : advancing;
      last = position;
      if (advancing < 2 || tries >= RESUME_TRIES) continue;
      tries++;
      advancing = 0;
      last = null;
      await active.renderer.seek(positionMs).catch(() => {});
    }
    if (this.active.get(rendererId) === active && active.resumeAt !== null) {
      console.warn(`[Playback] ${active.renderer.name} didn't resume the file at ${DlnaRenderer.clock(positionMs)}`);
      await this.fallBack(rendererId, active);
    }
  }

  /** Reads the renderer's state and position, saving progress and letting go of one that has stopped or vanished. */
  private async poll(rendererId: string): Promise<void> {
    const active = this.active.get(rendererId);
    if (!active || active.busy) return;

    let state: RendererState;
    let failed: boolean;
    let position: number;
    try {
      ({ state, failed } = await active.renderer.transportInfo());
      position = (await active.renderer.position()).positionMs;
      active.failures = 0;
    } catch {
      active.failures++;
      if (active.failures >= MAX_FAILURES) {
        active.state = "unreachable";
        this.report(active, "stop");
        await this.release(rendererId, false);
      }
      return;
    }
    if (this.active.get(rendererId) !== active || active.busy) return;

    // A file still to be seeked to its resume point shows as starting (or paused), and saves nothing yet
    if (active.resumeAt !== null) {
      active.state = state === "paused" ? "paused" : "loading";
      active.session.touch();
      return;
    }

    // The volume changes rarely; ask now and then
    if (active.polls++ % 5 === 0) Object.assign(active, await active.renderer.volume().catch(() => ({ volume: active.volume, muted: active.muted })));

    // Not yet seen playing: started once its position moves forward, since the first one read may be the last item's
    if (!active.started) {
      const advancing = state === "playing" && active.lastPolledMs !== null && position > active.lastPolledMs;
      active.lastPolledMs = state === "playing" ? position : null;
      if (advancing) active.started = true;
      else if (active.session.direct || state === "playing") {
        // A file that errors or never gets going is sent again as a stream
        if (active.session.direct && (failed || Date.now() - active.loadedAt > DIRECT_START_MS)) return this.fallBack(rendererId, active);
        active.state = "loading";
        active.session.touch();
        return;
      }
    }

    // Only a playing or paused renderer's position means anything
    const previous = active.state;
    active.state = state;
    if (state === "playing" || state === "paused") {
      active.stoppedAt = null;
      // Paused before it started, the position read may still be the last item's
      if (active.started) {
        active.positionMs = Math.min(active.offsetMs + position, active.session.item.durationMs);
        active.session.positionMs = active.positionMs;
      }
      active.session.touch();
      if (state === "paused" && previous === "playing") this.report(active, "pause");
      else if (Date.now() - active.lastReport >= REPORT_MS) this.report(active, "tick");
      return;
    }

    // Stopped or emptied: save once, then let go after a while
    if (state === "loading") {
      active.session.touch();
      return;
    }
    if (active.stoppedAt === null) {
      active.stoppedAt = Date.now();
      this.report(active, "stop");
    }
    active.session.touch();
    if (Date.now() - active.stoppedAt > STOPPED_RELEASE_MS) await this.release(rendererId, false);
  }

  /** Stops driving a renderer and ends its session; `stop` also stops the renderer. */
  private async release(rendererId: string, stop: boolean): Promise<void> {
    const active = this.active.get(rendererId);
    if (!active) return;
    clearInterval(active.timer);
    this.active.delete(rendererId);
    if (stop) await active.renderer.stop().catch(() => {});
    await PlaybackService.getInstance().end(active.session.id, null);
  }

  /** Saves the viewer's position under the resume rules. */
  private report(active: Active, event: "tick" | "pause" | "seek" | "stop"): void {
    active.lastReport = Date.now();
    WatchHistory.report(
      active.session.userId,
      { ...active.item, sessionId: active.session.id, positionMs: active.positionMs, event },
      active.session.audioLanguage,
    );
  }

  /** DIDL-Lite describing the splash as a 1080p JPEG photo. */
  private splashMetadata(url: string): string {
    return (
      '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">' +
      '<item id="findr-splash" parentID="0" restricted="1">' +
      "<dc:title>Findr</dc:title><upnp:class>object.item.imageItem.photo</upnp:class>" +
      `<res protocolInfo="${Upnp.escape(SPLASH_PROTOCOL_INFO)}" resolution="1920x1080">${Upnp.escape(url)}</res>` +
      "</item></DIDL-Lite>"
    );
  }

  /** DIDL-Lite describing the stream, which many renderers need before they will play it. */
  private metadata(session: ProgressiveSession, url: string, label: string, offsetMs: number): string {
    const remaining = Math.max(session.item.durationMs - offsetMs, 0);
    const size = session.direct ? ` size="${session.item.size}"` : "";
    const kind = session.item.season === null ? "object.item.videoItem.movie" : "object.item.videoItem";
    return (
      '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">' +
      `<item id="${Upnp.escape(session.id)}" parentID="0" restricted="1">` +
      `<dc:title>${Upnp.escape(label)}</dc:title><upnp:class>${kind}</upnp:class>` +
      `<res protocolInfo="${Upnp.escape(session.protocolInfo)}" duration="${DlnaRenderer.clock(remaining)}.000"${size}>${Upnp.escape(url)}</res>` +
      "</item></DIDL-Lite>"
    );
  }
}
