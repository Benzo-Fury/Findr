/**
 * Findr as a Google Cast sender. It finds Cast devices on the server's
 * network and on every connected cast bridge's, loads a cast URL on one, and
 * from then on is the remote, just as it is for DLNA renderers: the web app
 * sends play, pause, seek, volume and stop through Findr, and Findr asks the
 * receiver how it is getting on, saving the viewer's progress as it goes.
 *
 * The receiver fetches its stream through a cast ticket, the same HLS a
 * browser casting with Google's own picker sends; the session behind it is
 * made on the receiver's first request, sized for what that receiver decodes.
 *
 * A receiver picked to cast to before anything plays shows Findr's splash
 * until something is played on it or it is unpicked. Episodes chain on the
 * server, as they do for DLNA, under the viewer's autoplay and "still
 * watching" preferences.
 */

import {
  type PlaybackItemKey,
  type RendererCapabilities,
  type RendererCommand,
  type RendererOverrides,
  type RendererPlay,
  type RendererRecord,
  type RendererState,
  type RendererStatus,
  UP_NEXT_COUNTDOWN_MS,
} from "@findr/types/playback";
import { MediaItem } from "../../db/models/MediaItem";
import { PlaybackPrefs } from "../../db/models/PlaybackPrefs";
import { RendererOverride } from "../../db/models/RendererOverride";
import { SettingsStore } from "../../db/models/SettingsStore";
import SelfManagedSingleton from "../../other/SelfManagedSingleton";
import BridgeHub from "../bridge/BridgeHub";
import { CastAccess } from "../CastAccess";
import CreditsLocator from "../credits/CreditsLocator";
import { LocalRendererNetwork } from "../dlna/LocalRendererNetwork";
import type { RendererNetwork } from "../dlna/RendererNetwork";
import PlaybackService, { PlaybackError } from "../PlaybackService";
import { WatchHistory } from "../WatchHistory";
import { GoogleCastReceiver } from "./GoogleCastReceiver";

/** A receiver Findr is driving. */
interface Active {
  receiver: GoogleCastReceiver;
  /** What was asked for, kept to play the next episode the same way. */
  request: RendererPlay;
  /** The cast ticket the receiver fetches, which becomes a session on its first request. */
  ticket: string;
  /** That session's id, once the receiver has asked for it. */
  sessionId: string | null;
  media: MediaItem;
  item: PlaybackItemKey;
  userId: string;
  label: string;
  state: RendererState;
  positionMs: number;
  /** Polls in a row that got no answer. */
  failures: number;
  lastReport: number;
  /** When it stopped, if it has; a receiver left stopped is let go. */
  stoppedAt: number | null;
  /** A command is in flight; polls wait so they don't read a half-changed state. */
  busy: boolean;
  /** When the stream was loaded. */
  loadedAt: number;
  /** Whether it has been seen playing. */
  started: boolean;
  /** Where its credits start, once looked up; null until then, or when they can't be found. */
  creditsMs: number | null;
  /** The episode on disk after this one, or null. */
  next: PlaybackItemKey | null;
  /** Whether the next episode starts on its own: the viewer's preference, unless the remote turned it off for this one. */
  autoplay: boolean;
  /** Episodes in a row that started on their own, ending with this one; any command from the remote resets it. */
  chain: number;
  /** The viewer's "still watching" limit on `chain`; 0 never asks. */
  stillWatchingAfter: number;
  /** Moving on to the next episode, so polls don't start it twice. */
  advancing: boolean;
  timer: ReturnType<typeof setInterval>;
}

/** How often a driven receiver is asked how it is getting on. */
const POLL_MS = 2000;

/** How often progress is saved while it plays. */
const REPORT_MS = 10_000;

/** Searches more often than this reuse the last result unless asked to refresh. */
const SEARCH_REUSE_MS = 30_000;

/** A receiver not seen in searches for this long is forgotten. */
const FORGET_MS = 10 * 60_000;

/** Unanswered polls before a receiver counts as gone. */
const MAX_FAILURES = 5;

/** A stream that hasn't started playing in this long has failed; converting a far seek can take a while. */
const START_TIMEOUT_MS = 90_000;

/** A receiver stopped for this long is let go, ending its session. */
const STOPPED_RELEASE_MS = 60_000;

/** An episode that stops within this of its end, credits unknown, has finished, and the next may start. */
const FINISHED_MARGIN_MS = 90_000;

/** The HLS type receivers are told they are loading. */
const HLS_TYPE = "application/x-mpegURL";

export default class GoogleCastController extends SelfManagedSingleton {
  private readonly receivers = new Map<string, GoogleCastReceiver>();
  private readonly active = new Map<string, Active>();
  /** Receivers showing the splash, with the user who picked each. */
  private readonly splashes = new Map<string, string>();
  /** When each network was last searched, by network id. */
  private readonly lastSearch = new Map<string, number>();
  /** The search running on each network, by network id. */
  private readonly searching = new Map<string, Promise<void>>();

  // ---------- Discovery ---------- //

  /** Whether a renderer id is one of this controller's receivers. */
  public has(rendererId: string): boolean {
    return this.receivers.has(rendererId) || this.active.has(rendererId);
  }

  /**
   * The receivers on every network that can be reached, searching again
   * where the last search is stale or `refresh` is set.
   */
  public async list(refresh = false): Promise<RendererRecord[]> {
    const networks = [LocalRendererNetwork.instance, ...BridgeHub.getInstance().networks().filter((network) => network.connected)];
    const stale = networks.filter((network) => refresh || Date.now() - (this.lastSearch.get(network.id) ?? 0) > SEARCH_REUSE_MS);
    await Promise.all(stale.map((network) => this.search(network)));

    // A removed bridge's receivers go, unless one is still being driven
    const hub = BridgeHub.getInstance();
    for (const [id, receiver] of this.receivers) {
      if (!receiver.network.local && !hub.get(receiver.network.id) && !this.active.has(id)) this.forget(id);
    }

    return [...this.receivers.values()].filter((receiver) => receiver.network.connected).map((receiver) => receiver.toRecord());
  }

  /** How many receivers were last found on a network. */
  public countOn(networkId: string): number {
    return [...this.receivers.values()].filter((receiver) => receiver.network.id === networkId).length;
  }

  /** One search at a time on each network; callers during a search share it. */
  private search(network: RendererNetwork): Promise<void> {
    const running = this.searching.get(network.id);
    if (running) return running;
    const search = (async () => {
      try {
        const devices = await network.searchCast();
        const now = Date.now();

        // Add what is new; refresh what answered again, which may have moved
        for (const device of devices) {
          const fresh = new GoogleCastReceiver(device, network, () => this.detected());
          const existing = this.receivers.get(fresh.id);
          if (existing) {
            if (existing.device.host !== device.host || existing.device.port !== device.port) existing.disconnect();
            existing.device = device;
            existing.lastSeen = now;
            continue;
          }
          fresh.overrides = RendererOverride.get(fresh.id);
          this.receivers.set(fresh.id, fresh);
        }

        // Forget this network's receivers long gone, unless one is being driven
        for (const [id, receiver] of this.receivers) {
          if (receiver.network === network && now - receiver.lastSeen > FORGET_MS && !this.active.has(id)) this.forget(id);
        }
        this.lastSearch.set(network.id, now);
      } finally {
        this.searching.delete(network.id);
      }
    })();
    this.searching.set(network.id, search);
    return search;
  }

  /** What every receiver is taken to decode before corrections: the `chromecastProfile` setting. */
  private detected(): RendererCapabilities {
    const all = SettingsStore.section("playback").chromecastProfile === "4k-hdr";
    return { hevc: all, uhd: all, hdr: all };
  }

  /** Drops a receiver and its connection. */
  private forget(id: string): void {
    this.receivers.get(id)?.disconnect();
    this.receivers.delete(id);
  }

  // ---------- Playing ---------- //

  /**
   * Plays a movie or episode on a receiver, replacing whatever Findr had it
   * playing. `chain` counts the episodes before it that started on their
   * own, for the "still watching" check; one asked for from the remote is 0.
   */
  public async play(rendererId: string, request: RendererPlay, userId: string, chain = 0): Promise<RendererStatus> {
    const receiver = this.receivers.get(rendererId) ?? this.active.get(rendererId)?.receiver;
    if (!receiver?.network.connected) throw new PlaybackError("renderer_not_found", 404);
    const base = receiver.network.mediaBase();
    if (!base) throw new PlaybackError("cast_address_unknown", 503);

    // The old stream goes; the receiver's player stays up for the new one
    await this.release(rendererId, false);
    this.splashes.delete(rendererId);
    const label = request.label || "Findr";
    const cast = PlaybackService.getInstance().castFor(request, { capabilities: receiver.capabilities, local: receiver.network.local }, base, userId);
    try {
      await receiver.load({ url: cast.url, contentType: HLS_TYPE, title: label, startMs: cast.startMs, imageUrl: null });
    } catch (error) {
      throw new PlaybackError("renderer_failed", 502, error instanceof Error ? error.message : String(error));
    }

    const prefs = PlaybackPrefs.get(userId);
    const next = MediaItem.nextAfter(request);
    const active: Active = {
      receiver,
      request,
      ticket: cast.ticket,
      sessionId: null,
      media: cast.item,
      item: { titleId: request.titleId, season: request.season, episode: request.episode },
      userId,
      label,
      state: "loading",
      positionMs: cast.startMs,
      failures: 0,
      lastReport: Date.now(),
      stoppedAt: null,
      busy: false,
      loadedAt: Date.now(),
      started: false,
      creditsMs: null,
      next: next ? { titleId: next.titleId, season: next.season, episode: next.episode } : null,
      autoplay: prefs.autoplayNext,
      chain,
      stillWatchingAfter: prefs.stillWatchingAfter,
      advancing: false,
      timer: setInterval(() => void this.poll(rendererId), POLL_MS),
    };
    active.timer.unref?.();
    this.active.set(rendererId, active);

    // The credits are found while it plays, long before they come
    if (next) {
      void CreditsLocator.getInstance()
        .creditsOf(cast.item)
        .then((creditsMs) => (active.creditsMs = creditsMs));
    }
    return this.status(rendererId, userId);
  }

  /** Carries out a command from the remote. */
  public async command(rendererId: string, command: RendererCommand, userId: string): Promise<RendererStatus> {
    const active = this.active.get(rendererId);
    const receiver = active?.receiver ?? this.receivers.get(rendererId);
    if (!receiver) throw new PlaybackError("renderer_not_found", 404);
    if (active && active.userId !== userId && command.action !== "volume" && command.action !== "mute") {
      // Anyone signed in may cast, but only the one who started this may drive it
      throw new PlaybackError("renderer_busy", 409);
    }

    if (active) active.busy = true;
    // Someone at the remote is watching, so the "still watching" count starts again
    if (active && command.action !== "volume" && command.action !== "mute") active.chain = 0;
    try {
      switch (command.action) {
        case "play":
          await receiver.play();
          if (active) active.state = "playing";
          break;
        case "pause":
          await receiver.pause();
          if (active) {
            active.state = "paused";
            this.report(active, "pause");
          }
          break;
        case "stop":
          if (active) this.report(active, "stop");
          await this.release(rendererId, true);
          break;
        case "seek":
          if (active) {
            const target = Math.min(Math.max(command.positionMs, 0), Math.max(active.media.durationMs - 1000, 0));
            await receiver.seek(target);
            active.positionMs = target;
            this.session(active)?.report(target);
            this.report(active, "seek");
          }
          break;
        case "volume":
          await receiver.setVolume(command.volume);
          break;
        case "mute":
          await receiver.setMuted(command.muted);
          break;
        case "autoplay":
          if (active) active.autoplay = command.enabled;
          break;
      }
    } catch (error) {
      throw new PlaybackError("renderer_failed", 502, error instanceof Error ? error.message : String(error));
    } finally {
      if (active) active.busy = false;
    }
    return this.status(rendererId, userId);
  }

  /**
   * Replaces an admin's corrections to what a receiver decodes, kept for the
   * next time it is found too. They apply from the next item it is sent.
   */
  public setOverrides(rendererId: string, overrides: RendererOverrides): RendererRecord {
    const receiver = this.receivers.get(rendererId);
    if (!receiver) throw new PlaybackError("renderer_not_found", 404);
    receiver.overrides = RendererOverride.set(rendererId, overrides);
    return receiver.toRecord();
  }

  /** What a receiver is doing, as far as Findr knows, and whether `userId` started it. */
  public status(rendererId: string, userId: string | null): RendererStatus {
    const active = this.active.get(rendererId);
    const receiver = active?.receiver ?? this.receivers.get(rendererId);
    if (!receiver) throw new PlaybackError("renderer_not_found", 404);
    const session = active ? this.session(active) : null;
    const { volume, muted } = receiver.volume;
    return {
      renderer: receiver.toRecord(),
      state: active?.state ?? "idle",
      item: active?.item ?? null,
      label: active?.label ?? null,
      mine: active !== undefined && active.userId === userId,
      positionMs: active?.positionMs ?? 0,
      durationMs: active?.media.durationMs ?? 0,
      volume,
      muted,
      mode: session?.plan.mode ?? null,
      audioTracks: active?.media.audioTracks() ?? [],
      audioTrack: active && session ? active.media.audioTrackOf(session.plan.audioStream) : (active?.request.audioTrack ?? null),
      creditsMs: active?.creditsMs ?? null,
      next: active?.next ?? null,
      autoplay: active ? this.autoplays(active) : false,
      askStillWatching: active ? this.asksStillWatching(active) : false,
    };
  }

  /** The receivers playing something a user started, so the web app can lead back to their remotes. */
  public castsOf(userId: string): RendererStatus[] {
    return [...this.active].filter(([, active]) => active.userId === userId).map(([rendererId]) => this.status(rendererId, userId));
  }

  // ---------- Splash ---------- //

  /**
   * Shows the splash on a receiver picked to cast to. Left alone when it
   * already plays something from Findr; a receiver that won't show it is no
   * failure, since the splash is only a courtesy.
   */
  public async showSplash(rendererId: string, userId: string): Promise<void> {
    const receiver = this.receivers.get(rendererId);
    if (!receiver?.network.connected) throw new PlaybackError("renderer_not_found", 404);
    const base = receiver.network.mediaBase();
    if (!base || this.active.has(rendererId)) return;
    try {
      // Someone watching another app on it keeps it
      if (await receiver.inUseElsewhere()) return;
      await receiver.load({ url: `${base}${CastAccess.SPLASH_PATH}`, contentType: "image/jpeg", title: "Findr", startMs: 0, imageUrl: null });
    } catch (error) {
      console.warn(`[Playback] ${receiver.device.name} didn't take the splash: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.splashes.set(rendererId, userId);
  }

  /** Clears the splash the same user put up, unless something has started playing since. */
  public async hideSplash(rendererId: string, userId: string): Promise<void> {
    if (this.splashes.get(rendererId) !== userId) return;
    this.splashes.delete(rendererId);
    if (this.active.has(rendererId)) return;
    const receiver = this.receivers.get(rendererId);
    await receiver?.stop().catch(() => {});
    receiver?.disconnect();
  }

  /** Stops every receiver Findr is driving, as when playback or casting is turned off. */
  public async stopAll(): Promise<void> {
    for (const [rendererId, userId] of [...this.splashes]) await this.hideSplash(rendererId, userId);
    for (const [rendererId, active] of [...this.active]) {
      this.report(active, "stop");
      await this.release(rendererId, true);
    }

    // Nothing is driven any more, so no connection need stay open
    for (const receiver of this.receivers.values()) receiver.disconnect();
  }

  /**
   * Told by the playback service that a Cast session ended, such as from the
   * admin's Now playing list: stop driving its receiver and stop the receiver.
   */
  public async released(sessionId: string): Promise<void> {
    for (const [rendererId, active] of this.active) {
      if (active.sessionId !== sessionId) continue;
      clearInterval(active.timer);
      this.active.delete(rendererId);
      await active.receiver.stop().catch(() => {});
      active.receiver.disconnect();
    }
  }

  // ---------- Inner workings ---------- //

  /** The session the receiver's stream became, once it has asked for it; remembered for `released`. */
  private session(active: Active) {
    const session = PlaybackService.getInstance().sessionOfTicket(active.ticket);
    if (session) active.sessionId = session.id;
    return session;
  }

  /** Asks the receiver how it is getting on, saving progress and letting go of one that has stopped or vanished. */
  private async poll(rendererId: string): Promise<void> {
    const active = this.active.get(rendererId);
    if (!active || active.busy) return;

    let playback;
    try {
      playback = await active.receiver.playback();
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

    // The session lives while the receiver does, paused included
    const session = this.session(active);
    session?.touch();
    const previous = active.state;
    active.state = playback.state;

    // Playing or paused: its position is the file's, since Findr's HLS keeps the file's timeline
    if (playback.state === "playing" || playback.state === "paused") {
      active.stoppedAt = null;
      if (playback.state === "playing") active.started = true;
      if (active.started) {
        active.positionMs = Math.min(playback.positionMs, active.media.durationMs);
        session?.report(active.positionMs);
      }
      if (playback.state === "paused" && previous === "playing") this.report(active, "pause");
      else if (active.started && Date.now() - active.lastReport >= REPORT_MS) this.report(active, "tick");

      // "Up next" has counted down through the start of the credits
      const countedDown = active.creditsMs !== null && active.positionMs >= active.creditsMs + UP_NEXT_COUNTDOWN_MS;
      if (playback.state === "playing" && countedDown && this.autoplays(active)) await this.advance(rendererId, active);
      return;
    }

    // Still opening: give up on one that never gets going
    if (playback.state === "loading") {
      if (!active.started && Date.now() - active.loadedAt > START_TIMEOUT_MS) {
        console.warn(`[Playback] ${active.receiver.device.name} never started ${active.label}`);
        active.state = "stopped";
        await this.release(rendererId, true);
      }
      return;
    }

    // Refused before it played: nothing to wait for
    if (playback.failed && !active.started) {
      console.warn(`[Playback] ${active.receiver.device.name} couldn't play ${active.label}`);
      await this.release(rendererId, true);
      return;
    }

    // Something else took the receiver over: let it go at once rather than take it back
    if (playback.takenOver) {
      this.report(active, "stop");
      await this.release(rendererId, false);
      active.receiver.disconnect();
      return;
    }

    // An episode that ran to its end (or into its credits) moves on to the next
    const finished = active.positionMs >= active.media.durationMs - FINISHED_MARGIN_MS || (active.creditsMs !== null && active.positionMs >= active.creditsMs);
    if (active.started && finished && this.autoplays(active)) return this.advance(rendererId, active);

    // Stopped: save once, then let go after a while
    if (active.stoppedAt === null) {
      active.stoppedAt = Date.now();
      this.report(active, "stop");
    }
    if (Date.now() - active.stoppedAt > STOPPED_RELEASE_MS) await this.release(rendererId, false);
  }

  // ---------- Next episode ---------- //

  /** Whether the next episode will start on its own. */
  private autoplays(active: Active): boolean {
    return active.next !== null && active.autoplay && !this.asksStillWatching(active);
  }

  /** Whether enough episodes have started on their own that the next waits for someone to ask. */
  private asksStillWatching(active: Active): boolean {
    return active.next !== null && active.stillWatchingAfter > 0 && active.chain >= active.stillWatchingAfter;
  }

  /**
   * Marks the episode watched and plays the next on the same receiver, from
   * the start, in the viewer's language. A next episode that won't start
   * leaves the receiver as it was, for the remote to offer it by hand.
   */
  private async advance(rendererId: string, active: Active): Promise<void> {
    const next = active.next;
    if (active.advancing || !next) return;
    active.advancing = true;
    active.busy = true;

    // Watched to the end, whatever of the credits played
    active.positionMs = active.media.durationMs;
    this.report(active, "stop");

    // The TV's title names the new episode
    const code = `S${String(next.season).padStart(2, "0")}E${String(next.episode).padStart(2, "0")}`;
    const label = /S\d+E\d+$/i.test(active.label) ? active.label.replace(/S\d+E\d+$/i, code) : `${active.label} ${code}`;
    console.info(`[Playback] ${active.receiver.device.name} finished ${active.label}; playing ${label}`);
    try {
      await this.play(rendererId, { ...next, startMs: 0, audioTrack: null, label }, active.userId, active.chain + 1);
    } catch (error) {
      console.warn(`[Playback] ${active.receiver.device.name} didn't start ${label}: ${error instanceof Error ? error.message : String(error)}`);
      active.autoplay = false;
      active.advancing = false;
      active.busy = false;
    }
  }

  /** Stops driving a receiver and ends its session; `stop` also closes the receiver's player. */
  private async release(rendererId: string, stop: boolean): Promise<void> {
    const active = this.active.get(rendererId);
    if (!active) return;
    clearInterval(active.timer);
    this.active.delete(rendererId);
    if (stop) {
      await active.receiver.stop().catch(() => {});
      active.receiver.disconnect();
    }
    const session = this.session(active);
    if (session) await PlaybackService.getInstance().end(session.id, null);
  }

  /** Saves the viewer's position under the resume rules. */
  private report(active: Active, event: "tick" | "pause" | "seek" | "stop"): void {
    active.lastReport = Date.now();
    const session = this.session(active);
    WatchHistory.report(active.userId, { ...active.item, sessionId: session?.id ?? null, positionMs: active.positionMs, event }, session?.audioLanguage ?? null);
  }
}
