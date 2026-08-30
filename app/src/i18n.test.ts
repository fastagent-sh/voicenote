import { expect, test } from "bun:test";
import { ZH, t } from "./i18n";

const src = await Bun.file(new URL("./main.ts", import.meta.url)).text();
const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

function literal(raw: string): string {
  if (raw[0] === '"') return JSON.parse(raw);
  return JSON.parse(`"${raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
}

// Every key the UI can render: t() calls, the settings-schema labels/placeholders
// that buildSettings/makeInput pass through t(), and the markup applyStaticI18n
// translates in place.
function renderedKeys(): string[] {
  const keys: string[] = [];
  for (const m of src.matchAll(/(?:\bt\(|\b(?:label|placeholder):\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g))
    keys.push(literal(m[1]));
  // `data-i18n(?![-\w])` so `data-i18n-title` (icon buttons, whose glyph text is
  // not translated) doesn't match. Entities are decoded because applyStaticI18n
  // keys off textContent.
  for (const m of html.matchAll(/<[^>]*\bdata-i18n(?![-\w])[^>]*>([^<]*)</g))
    if (m[1].trim()) keys.push(m[1].trim().replace(/&amp;/g, "&"));
  for (const m of html.matchAll(/title="([^"]+)"[^>]*\bdata-i18n-title\b/g)) keys.push(m[1]);
  return keys;
}

// Guards the failure this change is most likely to ship: a string added or
// reworded in main.ts/index.html that silently stays English under zh.
test("every user-facing string has a zh translation", () => {
  expect(renderedKeys().filter((k) => !(k in ZH))).toEqual([]);
});

test("placeholders are filled, missing keys fall back to the English source", () => {
  expect(t("Downloading {0}%", 42)).toMatch(/42/);
  expect(t("Enter {0} at {1}", "ABCD", "https://x")).toMatch(/ABCD/);
  expect(t("this key does not exist")).toBe("this key does not exist");
});
