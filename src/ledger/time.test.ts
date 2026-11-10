import { describe, expect, it } from "vitest";

import { duration, formatTs, parseTs } from "./time.ts";

describe("format ts", () => {
  it("format ts epoch", () => {
    expect(formatTs(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("format ts known instants", () => {
    expect(formatTs(1791108796123)).toBe("2026-10-04T10:13:16.123Z");
    expect(formatTs(946684799999)).toBe("1999-12-31T23:59:59.999Z");
    expect(formatTs(4107542401005)).toBe("2100-03-01T00:00:01.005Z");
  });

  it("format ts leap days", () => {
    expect(formatTs(1709210096789)).toBe("2024-02-29T12:34:56.789Z");
    expect(formatTs(951782400000)).toBe("2000-02-29T00:00:00.000Z");
  });
});

describe("parse ts", () => {
  it("parse ts is the inverse of format ts", () => {
    for (const ms of [0, 1791108796123, 946684799999, 4107542401005, 1709210096789, 951782400000]) {
      expect(parseTs(formatTs(ms))).toBe(ms);
    }
  });

  it("parse ts takes no fraction or a short one", () => {
    expect(parseTs("1970-01-01T00:00:00Z")).toBe(0);
    expect(parseTs("2026-10-04T10:13:16Z")).toBe(1791108796000);
    expect(parseTs("2026-10-04T10:13:16.1Z")).toBe(1791108796100);
    expect(parseTs("2026-10-04T10:13:16.12Z")).toBe(1791108796120);
    // A leap day: 2000 is a leap year, being divisible by 400.
    expect(formatTs(951782400000)).toBe("2000-02-29T00:00:00.000Z");
    expect(parseTs("2000-02-29T00:00:00Z")).toBe(951782400000);
  });

  it("parse ts refuses what format ts never writes", () => {
    for (const text of [
      "",
      "garbage",
      "2026-10-04T10:13:16+10:00",
      "2026-10-04T10:13:16.123+00:00",
      "2026-10-04T10:13:16",
      "2026-10-04 10:13:16Z",
      "2026-10-04T10:13:16.Z",
      "2026-10-04T10:13:16.1234Z",
      "2026-13-04T10:13:16Z",
      "2026-10-32T10:13:16Z",
      "2026-10-04T24:13:16Z",
      "2026-10-04T10:60:16Z",
      "2026-10-04T10:13:16Z\n",
      // 2100 is a century year not divisible by 400, and 2026 is a common year.
      "2100-02-29T00:00:00Z",
      "2026-02-29T00:00:00Z",
      // Not ASCII digits, or a sign where a digit belongs.
      "2026-10-04T10:13:1٦Z",
      "+026-10-04T10:13:16Z",
      // Before the epoch is not a Unix millisecond count.
      "1969-12-31T23:59:59Z",
    ]) {
      expect(parseTs(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe("duration", () => {
  it("duration says seconds under a minute", () => {
    expect(duration(0)).toBe("0s");
    expect(duration(999)).toBe("0s");
    expect(duration(59_999)).toBe("59s");
  });

  it("duration says whole minutes under an hour", () => {
    expect(duration(60_000)).toBe("1m");
    expect(duration(3_599_999)).toBe("59m");
  });

  it("duration says hours and two-digit minutes under a day", () => {
    expect(duration(3_600_000)).toBe("1h00m");
    expect(duration(2 * 3_600_000)).toBe("2h00m");
    expect(duration(2 * 3_600_000 + 5 * 60_000)).toBe("2h05m");
  });

  it("duration says days and two-digit hours from a day on", () => {
    expect(duration(86_400_000)).toBe("1d00h");
    expect(duration(90_000_000)).toBe("1d01h");
  });
});
