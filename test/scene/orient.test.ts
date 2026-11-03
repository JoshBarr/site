import { Quaternion, Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { orient } from "../../src/components/scene/trains/run";

const UP = new Vector3(0, 1, 0);

describe("orient", () => {
  // Every heading, up and down a 3% grade: north (-z) on a grade is the one
  // the shortest arc from +z rolled onto its side.
  const headings = Array.from({ length: 24 }, (_, k) => (k / 24) * 2 * Math.PI);

  it.each(headings.flatMap((h) => [-0.03, 0.03].map((g) => [h, g])))(
    "points the nose along the track and keeps the roof up (heading %f, grade %f)",
    (heading, grade) => {
      const along = new Vector3(Math.sin(heading), grade, Math.cos(heading));
      const rotation = orient(along, new Quaternion());
      const nose = new Vector3(0, 0, 1).applyQuaternion(rotation);
      const side = new Vector3(1, 0, 0).applyQuaternion(rotation);
      const roof = new Vector3(0, 1, 0).applyQuaternion(rotation);

      expect(nose.distanceTo(along.normalize())).toBeLessThan(1e-9);
      expect(Math.abs(side.y)).toBeLessThan(1e-9);
      expect(roof.dot(UP)).toBeGreaterThan(0.99);
    }
  );
});
