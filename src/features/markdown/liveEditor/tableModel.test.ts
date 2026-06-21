import { describe, expect, test } from "vitest";
import {
  escapeCell,
  isEditableTable,
  parseTableModel,
  serializeTable,
  splitRawCells,
  unescapeCell,
  type TableModel,
} from "./tableModel";

describe("splitRawCells", () => {
  test("strips outer pipes and trims cells", () => {
    expect(splitRawCells("| a | b | c |")).toEqual(["a", "b", "c"]);
    expect(splitRawCells("a | b")).toEqual(["a", "b"]);
  });

  test("keeps escaped pipes attached to their cell (raw, not split)", () => {
    expect(splitRawCells("| a \\| b | c |")).toEqual(["a \\| b", "c"]);
  });

  test("empty cells are preserved", () => {
    expect(splitRawCells("| a |  | c |")).toEqual(["a", "", "c"]);
    expect(splitRawCells("|  |  |")).toEqual(["", ""]);
  });
});

describe("escapeCell / unescapeCell", () => {
  test("unescape turns \\| into literal |", () => {
    expect(unescapeCell("a \\| b")).toBe("a | b");
    expect(unescapeCell("plain")).toBe("plain");
  });

  test("escape turns literal | into \\| and collapses newlines", () => {
    expect(escapeCell("a | b")).toBe("a \\| b");
    expect(escapeCell("line1\nline2")).toBe("line1 line2");
    expect(escapeCell("crlf\r\nhere")).toBe("crlf here");
  });

  test("escape∘unescape is identity for cells whose only escape is \\|", () => {
    for (const raw of ["plain", "a \\| b", "多个 \\| 管道 \\| 符", "trailing\\|", "\\|leading"]) {
      expect(escapeCell(unescapeCell(raw))).toBe(raw);
    }
  });

  test("unescape∘escape is identity for ANY display text (incl. backslashes)", () => {
    // This is the contract that matters for user edits: whatever the user typed into a cell
    // must come back byte-identical after escape→serialize→parse→unescape.
    const displays = [
      "plain",
      "a | b", // literal pipe
      "a \\ b", // literal backslash
      "a\\|b", // literal backslash immediately before a pipe (the corruption case)
      "\\", // lone backslash
      "||", // consecutive pipes
      "中\\文 | 表\\格", // CJK + backslash + pipe mix
      "C:\\Users\\x|y", // windows path with a pipe
    ];
    for (const d of displays) {
      expect(unescapeCell(escapeCell(d))).toBe(d);
    }
  });
});

describe("parseTableModel", () => {
  test("parses a basic table", () => {
    const md = ["| h1 | h2 |", "| --- | --- |", "| a | b |", "| c | d |"].join("\n");
    expect(parseTableModel(md)).toEqual({
      header: ["h1", "h2"],
      aligns: [null, null],
      rows: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
  });

  test("parses all four alignment specs", () => {
    const md = ["| l | c | r | n |", "| :--- | :---: | ---: | --- |", "| 1 | 2 | 3 | 4 |"].join(
      "\n",
    );
    const model = parseTableModel(md);
    expect(model?.aligns).toEqual(["left", "center", "right", null]);
  });

  test("unescapes pipes in header and body cells", () => {
    const md = ["| a \\| b | c |", "| --- | --- |", "| x \\| y | z |"].join("\n");
    expect(parseTableModel(md)).toEqual({
      header: ["a | b", "c"],
      aligns: [null, null],
      rows: [["x | y", "z"]],
    });
  });

  test("preserves CJK and empty cells", () => {
    const md = ["| 薄荷 | 女儿 |", "| --- | --- |", "| 云云 |  |"].join("\n");
    expect(parseTableModel(md)).toEqual({
      header: ["薄荷", "女儿"],
      aligns: [null, null],
      rows: [["云云", ""]],
    });
  });

  test("rejects non-tables", () => {
    expect(parseTableModel("just one line")).toBeNull();
    expect(parseTableModel("| h |\nnot a separator row")).toBeNull();
    expect(parseTableModel("")).toBeNull();
  });

  test("ignores blank lines between rows", () => {
    const md = ["| h |", "| --- |", "", "| a |", ""].join("\n");
    expect(parseTableModel(md)?.rows).toEqual([["a"]]);
  });
});

describe("serializeTable", () => {
  test("emits canonical pipe table", () => {
    const model: TableModel = {
      header: ["h1", "h2"],
      aligns: [null, null],
      rows: [["a", "b"]],
    };
    expect(serializeTable(model)).toBe(["| h1 | h2 |", "| --- | --- |", "| a | b |"].join("\n"));
  });

  test("preserves alignment in the separator row", () => {
    const model: TableModel = {
      header: ["l", "c", "r", "n"],
      aligns: ["left", "center", "right", null],
      rows: [],
    };
    expect(serializeTable(model).split("\n")[1]).toBe("| :--- | :---: | ---: | --- |");
  });

  test("escapes literal pipes written by an edit", () => {
    const model: TableModel = {
      header: ["a | b"],
      aligns: [null],
      rows: [["x | y"]],
    };
    expect(serializeTable(model)).toBe(["| a \\| b |", "| --- |", "| x \\| y |"].join("\n"));
  });

  test("pads short body rows but NEVER truncates an overflowing row (no content loss)", () => {
    const model: TableModel = {
      header: ["c1", "c2", "c3"],
      aligns: [null, null, null],
      rows: [["only-one"], ["a", "b", "c", "EXTRA"]],
    };
    const out = serializeTable(model);
    const lines = out.split("\n");
    // Widened to 4 columns to fit the overflow row; "EXTRA" survives.
    expect(out).toContain("EXTRA");
    expect(lines[0]).toBe("| c1 | c2 | c3 |  |"); // header padded
    expect(lines[2]).toBe("| only-one |  |  |  |"); // short row padded
    expect(lines[3]).toBe("| a | b | c | EXTRA |"); // overflow row kept whole
  });
});

describe("isEditableTable (widget gate)", () => {
  const parse = (md: string) => parseTableModel(md) as TableModel;

  test("true for a clean rectangular table", () => {
    expect(isEditableTable(parse("| a | b |\n| --- | --- |\n| 1 | 2 |"))).toBe(true);
  });

  test("true when a body row is SHORTER than the header (benign padding)", () => {
    expect(isEditableTable(parse("| a | b | c |\n| --- | --- | --- |\n| 1 |"))).toBe(true);
  });

  test("false when a body row OVERFLOWS the header (ambiguous → read-only)", () => {
    expect(isEditableTable(parse("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |"))).toBe(false);
  });

  test("false when the separator width does not match the header", () => {
    // `| pipe` inside a code span splits the header from 2 to 3 while separator stays 2.
    expect(isEditableTable(parse("| `a|b` | c |\n| --- | --- |\n| x | y |"))).toBe(false);
  });
});

describe("round-trip fidelity (parse ∘ serialize)", () => {
  const cases: Record<string, string> = {
    basic: ["| h1 | h2 |", "| --- | --- |", "| a | b |"].join("\n"),
    aligned: ["| l | c | r |", "| :--- | :---: | ---: |", "| 1 | 2 | 3 |"].join("\n"),
    escapedPipes: ["| a \\| b | c |", "| --- | --- |", "| x \\| y | z |"].join("\n"),
    cjk: ["| 薄荷 | 女儿们 |", "| --- | --- |", "| 云云 | 长发 |"].join("\n"),
    emptyCells: ["| a | b |", "| --- | --- |", "|  | d |", "| e |  |"].join("\n"),
    headerOnly: ["| just header |", "| --- |"].join("\n"),
  };

  for (const [name, src] of Object.entries(cases)) {
    test(`serialize(parse(src)) re-parses to the same model — ${name}`, () => {
      const model = parseTableModel(src);
      expect(model).not.toBeNull();
      const reparsed = parseTableModel(serializeTable(model as TableModel));
      expect(reparsed).toEqual(model);
    });

    test(`serialization is idempotent — ${name}`, () => {
      const once = serializeTable(parseTableModel(src) as TableModel);
      const twice = serializeTable(parseTableModel(once) as TableModel);
      expect(twice).toBe(once);
    });
  }

  test("a literal pipe typed into a cell survives the round-trip as content", () => {
    // User edits a cell to contain a literal pipe; it must come back as a pipe, not a delimiter.
    const edited: TableModel = {
      header: ["formula"],
      aligns: [null],
      rows: [["a | b | c"]],
    };
    const reparsed = parseTableModel(serializeTable(edited));
    expect(reparsed?.rows[0][0]).toBe("a | b | c");
    expect(reparsed?.header).toHaveLength(1); // pipes did NOT create new columns
  });

  test("a literal BACKSLASH-then-pipe typed into a cell survives (fuzz regression)", () => {
    // Found by the adversarial fuzz: without escaping `\`, `a\|b` would serialize to `a\\|b`
    // and re-parse as a split. It must come back as one cell containing `a\|b`.
    const edited: TableModel = {
      header: ["h"],
      aligns: [null],
      rows: [["a\\|b"], ["C:\\path|with|pipes"]],
    };
    const reparsed = parseTableModel(serializeTable(edited));
    expect(reparsed?.header).toHaveLength(1);
    expect(reparsed?.rows[0][0]).toBe("a\\|b");
    expect(reparsed?.rows[1][0]).toBe("C:\\path|with|pipes");
  });

  test("an overflowing body row loses NO content on round-trip (fuzz regression)", () => {
    // Found by the adversarial fuzz: body row wider than header used to be truncated.
    const src = ["| a | b |", "| --- | --- |", "| 1 | 2 | 3 | 4 |"].join("\n");
    const m2 = parseTableModel(serializeTable(parseTableModel(src) as TableModel));
    // Every original cell value is still present somewhere in the re-parsed table.
    const flat = [...(m2?.header ?? []), ...(m2?.rows.flat() ?? [])];
    for (const v of ["1", "2", "3", "4"]) expect(flat).toContain(v);
  });
});
