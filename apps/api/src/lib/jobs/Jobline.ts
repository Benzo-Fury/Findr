import Pipeline, { type Stage } from "../other/Pipeline";
import type { JoblineCtx } from "../../types/Jobline";
import query from "./stages/query";
import decide from "./stages/decide";
import sterilize from "./stages/sterilize";
import save from "./stages/save";

export type { LogLevel, JoblineCtx } from "../../types/Jobline";

export default class Jobline extends Pipeline<JoblineCtx> {
  public currentStatus = "started";

  public stages: Record<string, Stage<JoblineCtx>> = Jobline.stages<JoblineCtx, Record<string, Stage<JoblineCtx>>>({
    query,
    decide,
    sterilize,
    save,
  });
}
