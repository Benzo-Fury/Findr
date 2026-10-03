/**
 * Tests of container detection: an explicit `FINDR_CONTAINER` decides, and
 * otherwise Docker's and Podman's marker files do.
 */

import { describe, expect, test } from "bun:test";
import { Container } from "./Container";

/** A filesystem holding only the given paths. */
const holding = (...paths: string[]) => (path: string) => paths.includes(path);

describe("Container.detect", () => {
  test("finds Docker by /.dockerenv and Podman by /run/.containerenv", () => {
    expect(Container.detect(undefined, holding("/.dockerenv"))).toBe(true);
    expect(Container.detect(undefined, holding("/run/.containerenv"))).toBe(true);
    expect(Container.detect(undefined, holding())).toBe(false);
  });

  test("FINDR_CONTAINER overrides the marker files either way", () => {
    expect(Container.detect(true, holding())).toBe(true);
    expect(Container.detect(false, holding("/.dockerenv"))).toBe(false);
  });
});
