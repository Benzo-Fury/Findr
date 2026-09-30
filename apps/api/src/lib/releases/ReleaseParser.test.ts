import { describe, expect, test } from "bun:test";
import type { ReleaseKind } from "@findr/types/release";
import { ReleaseParser } from "./ReleaseParser";

const parser = new ReleaseParser();

// ---------- Structure ---------- //

describe("structure", () => {
  const cases: Array<[string, ReleaseKind, number[], number[]]> = [
    // [title, kind, seasons, episodes]
    ["Breaking.Bad.S01E01.720p.BluRay.x264-DEMAND", "episode", [1], [1]],
    ["The.Office.US.S02E01E02.720p.WEB-DL.x264", "episode", [2], [1, 2]],
    ["Friends.S03E01-E03.1080p.BluRay.x265", "episode", [3], [1, 2, 3]],
    ["Friends S03E01-03 1080p BluRay", "episode", [3], [1, 2, 3]],
    ["Show.S01E01-S01E03.1080p.WEB", "episode", [1], [1, 2, 3]],
    ["Top.Gear.22x01.720p.HDTV.x264-FoV", "episode", [22], [1]],
    ["Doctor.Who.2005.S01E01.720p.BluRay", "episode", [1], [1]],
    ["Stranger Things S04E01 Chapter One 2160p NF WEB-DL DDP5 1 Atmos DV HDR H 265-FLUX", "episode", [4], [1]],
    ["Severance.S02.1080p.ATVP.WEB-DL.DDP5.1.H.264-FLUX", "season", [2], []],
    ["Severance S02 COMPLETE 1080p WEB x264", "season", [2], []],
    ["Game of Thrones Season 1 Complete 1080p BluRay", "season", [1], []],
    ["The.Bear.S03.2160p.HULU.WEB-DL.DDP5.1.H.265-NTb", "season", [3], []],
    ["The.Wire.S01-S05.COMPLETE.720p.BluRay.x264", "multi-season", [1, 2, 3, 4, 5], []],
    ["The.Wire.S01-05.720p.BluRay", "multi-season", [1, 2, 3, 4, 5], []],
    ["Sherlock Seasons 1-4 Complete 1080p", "multi-season", [1, 2, 3, 4], []],
    ["Fargo S01 S02 1080p BluRay", "multi-season", [1, 2], []],
    ["Seinfeld.The.Complete.Series.1080p.WEB-DL", "complete-series", [], []],
    ["Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX", "movie", [], []],
    ["1917.2019.1080p.BluRay.x264-SPARKS", "movie", [], []],
    ["Oppenheimer (2023) [1080p] [BluRay] [5.1] [YTS.MX]", "movie", [], []],
  ];

  for (const [title, kind, seasons, episodes] of cases) {
    test(title, () => {
      const parsed = parser.parse(title);
      expect(parsed.kind).toBe(kind);
      expect(parsed.seasons).toEqual(seasons);
      expect(parsed.episodes).toEqual(episodes);
    });
  }

  test("a resolution like 1920x1080 is not read as an episode", () => {
    expect(parser.parse("Some.Movie.2020.1920x1080.WEB").kind).toBe("movie");
  });

  test("an episode title after a dash is not read as a range", () => {
    expect(parser.parse("Show.S01E05.-.1080p.WEB-DL").episodes).toEqual([5]);
  });
});

// ---------- Quality fields ---------- //

describe("quality fields", () => {
  test("reads a fully tagged web release", () => {
    const parsed = parser.parse("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX");
    expect(parsed).toMatchObject({
      resolution: "2160p",
      videoCodec: "x265",
      audioCodec: "DolbyAtmos",
      hdrFormat: "DolbyVision",
      releaseType: "WEB-DL",
      group: "FLUX",
      year: 2024,
      isRepack: false,
    });
  });

  test("prefers Remux over BluRay when both appear", () => {
    const parsed = parser.parse("Interstellar.2014.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-EPSiLON");
    expect(parsed.releaseType).toBe("Remux");
    expect(parsed.hdrFormat).toBe("HDR10");
    expect(parsed.group).toBe("EPSiLON");
  });

  test("takes the last plausible year so titles containing years parse correctly", () => {
    expect(parser.parse("Blade.Runner.2049.2017.1080p.BluRay.x264-SPARKS").year).toBe(2017);
    expect(parser.parse("1917.2019.1080p.BluRay.x264-SPARKS").year).toBe(2019);
  });

  test("detects PROPER and REPACK", () => {
    expect(parser.parse("Shogun.2024.S01E04.PROPER.1080p.WEB.h264-ETHEL").isRepack).toBe(true);
    expect(parser.parse("The.Matrix.1999.REPACK.1080p.BluRay.x265-RARBG").isRepack).toBe(true);
    expect(parser.parse("The.Matrix.1999.1080p.BluRay.x265-RARBG").isRepack).toBe(false);
  });

  test("reads bare WEB and h264 as WEB-DL and x264", () => {
    const parsed = parser.parse("Shogun.2024.S01E04.PROPER.1080p.WEB.h264-ETHEL");
    expect(parsed.releaseType).toBe("WEB-DL");
    expect(parsed.videoCodec).toBe("x264");
    expect(parsed.group).toBe("ETHEL");
  });

  test("infers WEB-DL from a streaming service tag", () => {
    expect(parser.parse("Show.S01E01.1080p.AMZN.x264-GRP").releaseType).toBe("WEB-DL");
  });

  test("flags cam and telesync rips", () => {
    expect(parser.parse("Deadpool.and.Wolverine.2024.1080p.HDCAM.x264-NoGroup").releaseType).toBe("CAM");
    expect(parser.parse("Some.Movie.2023.HDTS.x264").releaseType).toBe("TS");
  });

  test("does not read a title word as a release type", () => {
    // "Cam" is the title here, not the source
    expect(parser.parse("Cam.2018.1080p.NF.WEB-DL.x264").releaseType).toBe("WEB-DL");
  });

  test("ignores trailing site tags when reading the group", () => {
    expect(parser.parse("Ted.Lasso.S03E12.1080p.WEB.H264-SuccessfulCrab[TGx]").group).toBe("SuccessfulCrab");
  });

  test("falls back to bracket-style groups", () => {
    expect(parser.parse("Oppenheimer (2023) [1080p] [BluRay] [5.1] [YTS.MX]").group).toBe("YTS");
  });

  test("reports no group when there is no suffix", () => {
    expect(parser.parse("The.Office.US.S02E01E02.720p.WEB-DL.x264").group).toBeNull();
  });

  test("strips a trailing file extension", () => {
    const parsed = parser.parse("Movie.2021.1080p.BluRay.x264-GRP.mkv");
    expect(parsed.group).toBe("GRP");
  });

  test("reads SD resolutions as 480p", () => {
    expect(parser.parse("Old.Show.S01E01.480p.DVDRip.XviD").resolution).toBe("480p");
  });
});
