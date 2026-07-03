import { describe, expect, test } from "bun:test";
import { JobsRefreshState } from "./jobsState";

describe("JobsRefreshState", () => {
  test("renders first success, skips unchanged snapshot", () => {
    const s = new JobsRefreshState();
    expect(s.success(s.begin(false), "[a]")).toBe("render");
    expect(s.success(s.begin(false), "[a]")).toBe("skip");
    expect(s.success(s.begin(false), "[b]")).toBe("render");
  });

  test("stale success never renders, but resets the failure counter", () => {
    const s = new JobsRefreshState();
    s.success(s.begin(false), "[a]");
    const stale = s.begin(false);
    const fresh = s.begin(false);
    s.failure(); // one failure on the books
    expect(s.success(stale, "[old]")).toBe("skip"); // superseded: no render
    // ...but the engine answered, so escalation restarts from zero:
    expect(s.failure()).toBe("skip");
    expect(s.failure()).toBe("skip");
    expect(s.success(fresh, "[new]")).toBe("render");
  });

  test("cross-source overlap: superseded slow failures still escalate", () => {
    const s = new JobsRefreshState();
    s.success(s.begin(false), "[a]"); // last-good list on screen
    // Polls are chained and don't stack, but boot/post-save/status flows start
    // requests while one is in flight — so slow (timeout) failures arrive
    // already superseded. They must still count toward escalation.
    s.begin(false); // poll, will time out…
    s.begin(false); // …superseded by a post-save refresh
    expect(s.failure()).toBe("skip"); // poll's timeout: 1st failure, keep last-good
    s.begin(false); // another status-flow refresh
    expect(s.failure()).toBe("skip"); // 2nd failure, keep last-good
    expect(s.failure()).toBe("error"); // 3rd: must surface
  });

  test("explicit refresh superseded by a poll: the winning failure delivers feedback", () => {
    const s = new JobsRefreshState();
    s.success(s.begin(false), "[a]");
    s.begin(true); // user clicked refresh
    s.begin(false); // poll tick supersedes it
    // Whichever response settles first (here: a failure) owes the user feedback:
    expect(s.failure()).toBe("error");
  });

  test("explicit refresh superseded by a poll: the winning success satisfies feedback", () => {
    const s = new JobsRefreshState();
    s.success(s.begin(false), "[a]");
    s.begin(true); // user clicked refresh
    const poll = s.begin(false);
    expect(s.success(poll, "[a]")).toBe("skip"); // unchanged list, no re-render
    // Feedback was consumed by the success; a later failure is background-grade:
    expect(s.failure()).toBe("skip");
  });

  test("failure with nothing rendered yet is always visible", () => {
    const s = new JobsRefreshState();
    s.begin(false);
    expect(s.failure()).toBe("error");
  });

  test("stale success settles the explicit-feedback debt", () => {
    const s = new JobsRefreshState();
    s.success(s.begin(false), "[a]");
    const explicitSeq = s.begin(true); // user clicked refresh
    s.begin(false); // poll supersedes it
    expect(s.success(explicitSeq, "[a]")).toBe("skip"); // stale, list unchanged
    // The user's own request succeeded — debt settled. A later single
    // background failure must NOT escalate as if the user were still waiting:
    expect(s.failure()).toBe("skip");
  });

  test("stale success renders when an error is on screen", () => {
    const s = new JobsRefreshState();
    s.success(s.begin(false), "[a]");
    const explicitSeq = s.begin(true); // explicit refresh in flight…
    s.begin(false); // …superseded by a poll tick
    expect(s.failure()).toBe("error"); // the poll fails first: error rendered
    // The explicit request's success arrives late (stale seq), but the screen
    // shows an error — real data must replace it, not wait for the next tick:
    expect(s.success(explicitSeq, "[a]")).toBe("render");
  });

  test("after a visible error, the next success re-renders even an identical list", () => {
    const s = new JobsRefreshState();
    s.success(s.begin(false), "[a]");
    s.begin(true);
    expect(s.failure()).toBe("error"); // explicit failure shown, snapshot cleared
    expect(s.success(s.begin(false), "[a]")).toBe("render");
  });
});
