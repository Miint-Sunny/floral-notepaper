import { describe, expect, test } from "vitest";
import { parseOutline } from "./outline";

describe("parseOutline", () => {
  test("extracts heading level, text and zero-based line", () => {
    const items = parseOutline("# Title\n\nsome text\n\n## Section\n### Sub");
    expect(items).toEqual([
      { level: 1, text: "Title", slug: "title", line: 0, from: 0 },
      { level: 2, text: "Section", slug: "section", line: 4, from: 20 },
      { level: 3, text: "Sub", slug: "sub", line: 5, from: 31 },
    ]);
  });

  test("ignores headings inside fenced code blocks (``` and ~~~)", () => {
    const md = [
      "# Real",
      "```",
      "# fake in code",
      "```",
      "~~~",
      "## also fake",
      "~~~",
      "## Real2",
    ].join("\n");
    expect(parseOutline(md).map((h) => h.text)).toEqual(["Real", "Real2"]);
  });

  test("requires a space after the hashes and at most six", () => {
    const items = parseOutline("#nothash\n####### too many\n###### Six");
    expect(items.map((h) => h.text)).toEqual(["Six"]);
    expect(items[0].level).toBe(6);
  });

  test("strips inline markdown so the text matches the rendered heading", () => {
    const items = parseOutline("# **Bold** and `code` and [link](http://x)");
    expect(items[0].text).toBe("Bold and code and link");
    expect(items[0].slug).toBe("bold-and-code-and-link");
  });

  test("drops optional closing hashes", () => {
    expect(parseOutline("## Title ##")[0].text).toBe("Title");
  });

  test("disambiguates duplicate headings like rehype-slug", () => {
    const items = parseOutline("# Hello\n# Hello\n# Hello");
    expect(items.map((h) => h.slug)).toEqual(["hello", "hello-1", "hello-2"]);
  });

  test("returns an empty list when there are no headings", () => {
    expect(parseOutline("just a paragraph\nand another line")).toEqual([]);
  });
});
