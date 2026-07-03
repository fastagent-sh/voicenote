import { describe, expect, test } from "bun:test";
import { deriveNoProxy, envKeysToEmbed, hydrateFromFileEnv, parseFileEnv } from "./envConfig";

const VOLCANO = [".volces.com", "openspeech.bytedance.com"] as const;

const KEYS = ["A_KEY", "B_KEY", "C_KEY"] as const;

describe("parseFileEnv", () => {
  test("config.json wins over .zshrc; zshrc fills the gaps", () => {
    const out = parseFileEnv(KEYS, { A_KEY: "from-config" }, 'export A_KEY="from-zshrc"\nexport B_KEY="zshrc-only"\n', "/home/u");
    expect(out).toEqual({ A_KEY: "from-config", B_KEY: "zshrc-only" });
  });

  test("expands $HOME and ${HOME} in both sources", () => {
    const out = parseFileEnv(KEYS, { A_KEY: "$HOME/x" }, "export B_KEY=${HOME}/y\n", "/home/u");
    expect(out).toEqual({ A_KEY: "/home/u/x", B_KEY: "/home/u/y" });
  });

  test("zshrc quoting forms, including an explicit empty string", () => {
    const out = parseFileEnv(KEYS, {}, "export A_KEY=\"\"\nexport B_KEY='single'\nexport C_KEY=bare # comment\n", "/h");
    expect(out).toEqual({ A_KEY: "", B_KEY: "single", C_KEY: "bare" });
  });

  test("non-string config values and unknown keys are ignored", () => {
    const out = parseFileEnv(KEYS, { A_KEY: 42, NOT_A_KEY: "x", speakers: {} } as any, null, "/h");
    expect(out).toEqual({});
  });
});

describe("hydrateFromFileEnv", () => {
  test("fills only keys the real environment does not set", () => {
    const out = hydrateFromFileEnv(KEYS, { A_KEY: "real" }, { A_KEY: "file", B_KEY: "file-b" });
    expect(out).toEqual({ B_KEY: "file-b" });
  });

  test("an explicit empty string in the environment counts as set", () => {
    const out = hydrateFromFileEnv(KEYS, { A_KEY: "" }, { A_KEY: "file" });
    expect(out).toEqual({});
  });
});

describe("envKeysToEmbed", () => {
  test("hydrated and file-equal values are skipped (recoverable at run time)", () => {
    const { embed, frozenOverrides } = envKeysToEmbed(
      KEYS,
      { A_KEY: "hydrated-val", B_KEY: "same-as-file" },
      new Set(["A_KEY"]),
      { B_KEY: "same-as-file" },
    );
    expect(embed).toEqual({});
    expect(frozenOverrides).toEqual([]);
  });

  test("real-env-only values are embedded without an override report", () => {
    const { embed, frozenOverrides } = envKeysToEmbed(KEYS, { A_KEY: "real-only", B_KEY: "" }, new Set(), {});
    // Empty string is a meaningful value (e.g. disable summary tools) — kept.
    expect(embed).toEqual({ A_KEY: "real-only", B_KEY: "" });
    expect(frozenOverrides).toEqual([]);
  });

  test("a real-env value differing from the file is embedded AND reported frozen", () => {
    const { embed, frozenOverrides } = envKeysToEmbed(KEYS, { A_KEY: "stale-shell" }, new Set(), { A_KEY: "fresh-config" });
    expect(embed).toEqual({ A_KEY: "stale-shell" });
    expect(frozenOverrides).toEqual(["A_KEY"]);
  });
});

describe("deriveNoProxy (provenance of the volcano-merged no_proxy)", () => {
  test("synthesized from nothing: merged runtime, hydrated, nothing to capture", () => {
    const r = deriveNoProxy(undefined, undefined, false, true, "localhost,127.0.0.1", VOLCANO);
    expect(r.runtime).toBe("localhost,127.0.0.1,.volces.com,openspeech.bytedance.com");
    expect(r.hydrate).toBe(true);
    expect(r.capture).toBeUndefined();
  });

  test("synthesized with no active proxy: base is empty, only volcano hosts", () => {
    const r = deriveNoProxy(undefined, undefined, false, false, "localhost", VOLCANO);
    expect(r.runtime).toBe(".volces.com,openspeech.bytedance.com");
    expect(r.hydrate).toBe(true);
  });

  test("real-env value: captures the PRE-MERGE original (never the merge)", () => {
    const r = deriveNoProxy("example.com", undefined, false, true, "localhost", VOLCANO);
    expect(r.runtime).toBe("example.com,.volces.com,openspeech.bytedance.com");
    expect(r.capture).toBe("example.com"); // scheduler embeds THIS, not runtime
    expect(r.hydrate).toBe(false);
  });

  test("reload idempotency: already-captured original is not re-captured from the merged value", () => {
    // Second pass sees the already-merged runtime as `current`; capturedOriginal
    // is set, so it must NOT overwrite it with the merged string.
    const merged = "example.com,.volces.com,openspeech.bytedance.com";
    const r = deriveNoProxy(merged, "example.com", false, true, "localhost", VOLCANO);
    expect(r.capture).toBeUndefined();
    expect(r.runtime).toBe(merged); // merge is idempotent
  });

  test("end-to-end embed decision: scheduler embeds the pre-merge original, not the merge", () => {
    // Mirror launchAgentEnv: substitute the captured pre-merge original into the
    // env snapshot before deciding what to embed.
    const derived = deriveNoProxy("example.com", undefined, false, true, "localhost", VOLCANO);
    const embedEnv = { no_proxy: derived.capture }; // launchAgentEnv's substitution
    const { embed } = envKeysToEmbed(["no_proxy"], embedEnv, new Set(), {});
    expect(embed).toEqual({ no_proxy: "example.com" }); // NOT the .volces.com merge
  });

  test("end-to-end embed decision: a synthesized no_proxy is not embedded at all", () => {
    const derived = deriveNoProxy(undefined, undefined, false, true, "localhost", VOLCANO);
    const embedEnv = { no_proxy: derived.capture }; // undefined
    const hydrated = new Set(derived.hydrate ? ["no_proxy"] : []);
    const { embed } = envKeysToEmbed(["no_proxy"], embedEnv, hydrated, {});
    expect(embed).toEqual({});
  });
});
