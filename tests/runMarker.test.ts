import { describe, expect, it } from "vitest";
import {
  driveRunMarker,
  hasPromanRunMarker,
  parseDriveRunId,
  parseTaskRunId,
  taskRunMarker,
} from "../src/agent/runMarker";

describe("runMarker", () => {
  it("builds and parses task run markers", () => {
    const m = taskRunMarker("plan_1");
    expect(m).toBe("PROMAN_TASK_RUN:plan_1");
    expect(parseTaskRunId(`${m}\n\n# hello`)).toBe("plan_1");
    expect(parseTaskRunId("no marker here")).toBeUndefined();
  });

  it("builds and parses drive run markers", () => {
    const m = driveRunMarker("docs-plans-x");
    expect(m).toBe("PROMAN_DRIVE_RUN:docs-plans-x");
    expect(parseDriveRunId(`prefix ${m} suffix`)).toBe("docs-plans-x");
  });

  it("detects either marker", () => {
    expect(hasPromanRunMarker("PROMAN_TASK_RUN:t1")).toBe(true);
    expect(hasPromanRunMarker("PROMAN_DRIVE_RUN:tree")).toBe(true);
    expect(hasPromanRunMarker("ordinary chat")).toBe(false);
  });
});
