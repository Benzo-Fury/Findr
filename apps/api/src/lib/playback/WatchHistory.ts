/**
 * What each user has watched: recording positions under the resume rules,
 * marking items played, and building the view of the library the web app
 * shows — every playable item with its progress, what to continue, and the
 * next episode of each show in progress.
 */

import type { PlayableItem, PlaybackItemKey, PlaybackLibrary, PlaybackSettings, ReportProgress } from "@findr/types/playback";
import { MediaItem } from "../db/models/MediaItem";
import { PlaybackProgress } from "../db/models/PlaybackProgress";
import { SettingsStore } from "../db/models/SettingsStore";

/** A stable string for a movie or episode. */
function keyOf(key: PlaybackItemKey): string {
  return `${key.titleId}:${key.season ?? "-"}:${key.episode ?? "-"}`;
}

export class WatchHistory {
  /**
   * Records where a user is in an item. Under the minimum share or for a
   * short item no resume point is kept; past the maximum share it counts as
   * played. Returns false when the item isn't indexed.
   */
  public static report(userId: string, report: ReportProgress, audioLanguage: string | null = null): boolean {
    const item = MediaItem.findForKey(report);
    if (!item) return false;

    const outcome = this.classify(report.positionMs, item.durationMs, SettingsStore.section("playback"));
    // Too early to keep, and nothing to overwrite: record nothing
    if (outcome === "discard" && !PlaybackProgress.find(userId, report)) return true;

    PlaybackProgress.record(userId, report, {
      positionMs: outcome === "resume" ? report.positionMs : 0,
      durationMs: item.durationMs,
      finished: outcome === "played",
      audioLanguage,
    });
    return true;
  }

  /** Marks an item played or unplayed. */
  public static markPlayed(userId: string, key: PlaybackItemKey, played: boolean): void {
    PlaybackProgress.setPlayed(userId, key, played);
  }

  /** Everything playable with the user's progress, plus continue-watching and next-up suggestions. */
  public static library(userId: string): PlaybackLibrary {
    const progress = new Map(PlaybackProgress.forUser(userId).map((entry) => [keyOf(entry.key), entry]));

    // One entry per movie or episode; the newest file wins
    const items: PlayableItem[] = [];
    const seen = new Set<string>();
    for (const { item, tmdbId, mediaType } of MediaItem.allWithTitles()) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);

      const entry = progress.get(key);
      items.push({
        titleId: item.titleId,
        tmdbId,
        mediaType,
        season: item.season,
        episode: item.episode,
        durationMs: item.durationMs,
        positionMs: entry?.positionMs ?? 0,
        played: entry?.played ?? false,
        lastPlayedAt: entry?.lastPlayedAt ?? null,
      });
    }

    return { items, continueWatching: this.continueWatching(items), nextUp: this.nextUp(items) };
  }

  /** Items part-way through, most recently played first. */
  private static continueWatching(items: PlayableItem[]): PlaybackItemKey[] {
    return items
      .filter((item) => item.positionMs > 0 && item.lastPlayedAt !== null)
      .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
      .map(({ titleId, season, episode }) => ({ titleId, season, episode }));
  }

  /**
   * For each show, the first unplayed episode after the latest one finished,
   * skipping shows whose next episode is already in continue-watching.
   * Ordered by when the show was last watched.
   */
  private static nextUp(items: PlayableItem[]): PlaybackItemKey[] {
    // Group episodes by show, in season and episode order
    const shows = new Map<string, PlayableItem[]>();
    for (const item of items) {
      if (item.mediaType !== "tv") continue;
      const list = shows.get(item.titleId) ?? [];
      list.push(item);
      shows.set(item.titleId, list);
    }

    const suggestions: Array<{ key: PlaybackItemKey; at: number }> = [];
    for (const episodes of shows.values()) {
      episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));

      // The latest finished episode, by when it was watched
      let latest = -1;
      let latestAt = 0;
      episodes.forEach((episode, index) => {
        if (episode.played && (episode.lastPlayedAt ?? 0) >= latestAt) {
          latest = index;
          latestAt = episode.lastPlayedAt ?? 0;
        }
      });
      if (latest < 0) continue;

      const next = episodes.slice(latest + 1).find((episode) => !episode.played);
      if (!next || next.positionMs > 0) continue;
      suggestions.push({ key: { titleId: next.titleId, season: next.season, episode: next.episode }, at: latestAt });
    }
    return suggestions.sort((a, b) => b.at - a.at).map((entry) => entry.key);
  }

  /** What a stopping position means under the resume rules. */
  private static classify(positionMs: number, durationMs: number, settings: PlaybackSettings): "discard" | "resume" | "played" {
    if (durationMs <= 0) return "discard";
    const share = (positionMs / durationMs) * 100;
    if (share >= settings.maxResumePercent) return "played";
    if (share < settings.minResumePercent || durationMs < settings.minResumeDurationSeconds * 1000) return "discard";
    return "resume";
  }
}
