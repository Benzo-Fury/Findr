import { spawn } from "node:child_process";
import config from "../../config.json";

interface Encoder {
  name: string;
  args: string[];
}

/**
 * Hardware and software H.264 encoders ranked by preference. Each entry
 * carries the encoder name as ffmpeg knows it plus the quality-tuning flags
 * specific to that encoder — these differ across vendors so a single set of
 * flags cannot be shared.
 */
const ENCODER_PREFERENCE: Encoder[] = [
  { name: "h264_videotoolbox", args: ["-c:v", "h264_videotoolbox", "-q:v", "85"] },
  { name: "h264_nvenc",        args: ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "18"] },
  { name: "h264_qsv",          args: ["-c:v", "h264_qsv", "-global_quality", "18", "-preset", "medium"] },
  { name: "h264_vaapi",        args: ["-c:v", "h264_vaapi", "-qp", "18"] },
  { name: "h264_amf",          args: ["-c:v", "h264_amf", "-quality", "balanced", "-qp_i", "18", "-qp_p", "18"] },
  { name: "libx264",           args: ["-c:v", "libx264", "-crf", "18", "-preset", "medium"] },
];

/**
 * Probes the configured ffmpeg binary for available H.264 encoders and returns
 * a ranked list from most preferred (hardware) to least preferred (software).
 * Only encoders that the current ffmpeg build actually supports are included.
 */
export async function probeEncoders(): Promise<Encoder[]> {
  const available = await new Promise<Set<string>>((resolve) => {
    const proc = spawn(config.paths.ffmpeg, ["-encoders", "-v", "quiet"]);
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("error", () => resolve(new Set()));
    proc.on("close", () => {
      const names = new Set<string>();
      for (const encoder of ENCODER_PREFERENCE) {
        if (out.includes(encoder.name)) names.add(encoder.name);
      }
      resolve(names);
    });
  });

  return ENCODER_PREFERENCE.filter((e) => available.has(e.name));
}

/**
 * Resolves the video encoder args to pass to ffmpeg. When the user has
 * disabled automatic encoder probing, returns only their custom args (or
 * the libx264 software fallback when no custom args are set). Otherwise
 * probes ffmpeg and picks the highest-ranked available encoder.
 */
export async function resolveEncoderArgs(): Promise<{ name: string; args: string[] }> {
  const ffmpegConfig = config.ffmpeg;

  if (ffmpegConfig?.disableAutoEncoder) {
    const customArgs = (ffmpegConfig.extraArgs ?? []) as string[];
    if (customArgs.length > 0) {
      const nameFlag = customArgs.indexOf("-c:v");
      const name = nameFlag !== -1 ? customArgs[nameFlag + 1] ?? "custom" : "custom";
      return { name, args: customArgs };
    }
    const fallback = ENCODER_PREFERENCE.at(-1)!;
    return { name: fallback.name, args: fallback.args };
  }

  const encoders = await probeEncoders();
  const best = encoders[0] ?? ENCODER_PREFERENCE.at(-1)!;

  const extraArgs = ffmpegConfig?.extraArgs ?? [];
  return { name: best.name, args: [...best.args, ...extraArgs] };
}
