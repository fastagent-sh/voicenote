import { describe, expect, test } from "bun:test";
import { parseLockOwner } from "./runLock";

describe("parseLockOwner", () => {
  test("our own pid → mine", () => {
    expect(parseLockOwner(JSON.stringify({ pid: 42, ts: 1 }), 42)).toBe("mine");
  });

  test("a different live pid → reclaimed", () => {
    expect(parseLockOwner(JSON.stringify({ pid: 99, ts: 1 }), 42)).toBe("reclaimed");
  });

  test("read failure (null) → unknown, NOT reclaimed", () => {
    // The whole point: a transient EBUSY must not look like someone stole the lock.
    expect(parseLockOwner(null, 42)).toBe("unknown");
  });

  test("corrupt/partial JSON → unknown", () => {
    expect(parseLockOwner('{"pid":4', 42)).toBe("unknown");
  });

  test("missing / non-numeric pid → unknown", () => {
    expect(parseLockOwner(JSON.stringify({ ts: 1 }), 42)).toBe("unknown");
    expect(parseLockOwner(JSON.stringify({ pid: "abc" }), 42)).toBe("unknown");
  });
});
