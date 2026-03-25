export type Data = Record<string, unknown>;

export interface Stage<TCtx extends Data = Data> {
  // name: string; - Name is derived from key when defined
  callback: (ctx: TCtx) => Partial<TCtx> | void | Promise<Partial<TCtx> | void>;

  /**
   * The status to set when this stage is called.
   * If no status is provided, the stage name will be used.
   */
  status?: string;
}

export default abstract class Pipeline<TCtx extends Data = Data> {
  public abstract readonly stages: Record<string, Stage<TCtx>>;
  public currentStatus: string = "";

  /** Helper to define stages with type inference — enforces the Stage contract while preserving narrow key types. */
  protected static stages<TCtx extends Data, T extends Record<string, Stage<TCtx>>>(s: T): T {
    return s;
  }

  /** Runs the pipeline from the first stage. */
  async run(
    data: TCtx = {} as TCtx,
    onStatusUpdate?: (status: string) => any,
  ): Promise<void> {
    const [first] = Object.keys(this.stages);
    if (!first) return;
    await this.runFrom(first, data, onStatusUpdate);
  }

  /**
   * Runs the pipeline from a specific stage.
   * Remember that if this stage or subsequent stages expect certain data that is typically defined
   * by earlier stages, it will need to be manually provided.
   */
  async runFrom(
    startStage: string,
    data: TCtx = {} as TCtx,
    onStatusUpdate?: (status: string) => any,
  ): Promise<void> {
    const keys = Object.keys(this.stages);
    const startIndex = keys.indexOf(startStage);
    if (startIndex === -1)
      throw new Error(`Stage "${startStage}" not found in pipeline`);

    let ctx: TCtx = { ...data };

    for (const key of keys.slice(startIndex)) {
      const stage = this.stages[key];
      this.currentStatus = stage.status ?? key;
      if (onStatusUpdate) {
        await onStatusUpdate(this.currentStatus);
      }

      const result = await stage.callback(ctx);
      if (result !== undefined) ctx = { ...ctx, ...result } as TCtx;
    }
  }
}
