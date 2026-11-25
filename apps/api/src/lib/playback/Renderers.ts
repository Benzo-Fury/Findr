/**
 * Every TV Findr can cast to, whatever it speaks: DLNA renderers and Google
 * Cast receivers in one list, each driven by its own controller. The routes
 * and the web app see one kind of TV; this decides which controller a TV
 * belongs to.
 */

import type { RendererCommand, RendererOverrides, RendererPlay, RendererRecord, RendererStatus } from "@findr/types/playback";
import DlnaController from "./dlna/DlnaController";
import GoogleCastController from "./googlecast/GoogleCastController";

/** What both controllers do for one of their TVs. */
interface Controller {
  play(rendererId: string, request: RendererPlay, userId: string): Promise<RendererStatus>;
  command(rendererId: string, command: RendererCommand, userId: string): Promise<RendererStatus>;
  status(rendererId: string, userId: string | null): RendererStatus;
  setOverrides(rendererId: string, overrides: RendererOverrides): RendererRecord;
  showSplash(rendererId: string, userId: string): Promise<void>;
  hideSplash(rendererId: string, userId: string): Promise<void>;
}

export class Renderers {
  /** Every TV on every network that can be reached, by name; both kinds are searched together. */
  public static async list(refresh = false): Promise<RendererRecord[]> {
    const [dlna, cast] = await Promise.all([DlnaController.getInstance().list(refresh), GoogleCastController.getInstance().list(refresh)]);
    return [...dlna, ...cast].sort((a, b) => a.name.localeCompare(b.name) || (a.place ?? "").localeCompare(b.place ?? ""));
  }

  /** How many TVs were last found on a network. */
  public static countOn(networkId: string): number {
    return DlnaController.getInstance().countOn(networkId) + GoogleCastController.getInstance().countOn(networkId);
  }

  /** The TVs playing something a user started. */
  public static castsOf(userId: string): RendererStatus[] {
    return [...DlnaController.getInstance().castsOf(userId), ...GoogleCastController.getInstance().castsOf(userId)].sort((a, b) =>
      a.renderer.name.localeCompare(b.renderer.name),
    );
  }

  /** The controller a TV belongs to: a Cast receiver's, else DLNA's, which answers for TVs it doesn't know. */
  public static of(rendererId: string): Controller {
    const cast = GoogleCastController.getInstance();
    return cast.has(rendererId) ? cast : DlnaController.getInstance();
  }
}
