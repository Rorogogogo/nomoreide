import { describe, expect, test } from "vitest";
import { csvCell, writeDatabaseExport } from "../src/core/db/export.js";
import type { ColumnInfo } from "../src/core/db/driver.js";

const columns: ColumnInfo[] = [
  { name: "id", dataType: "integer", nullable: false, primaryKey: true },
  { name: "name", dataType: "text", nullable: false, primaryKey: false },
  { name: "api_token", dataType: "text", nullable: true, primaryKey: false },
  { name: "meta", dataType: "json", nullable: true, primaryKey: false },
];

async function render(
  format: "csv" | "json",
  batches: Array<Array<Record<string, unknown>>>,
) {
  let output = "";
  const summary = await writeDatabaseExport(
    { async write(chunk) { output += chunk; } },
    format,
    columns,
    (async function* stream() { yield* batches; })(),
  );
  return { output, summary };
}

describe("database export serialization", () => {
  test("streams spreadsheet-safe CSV with masking and stable object values", async () => {
    const result = await render("csv", [[{
      id: 1,
      name: "=HYPERLINK(\"https://bad\")\nnext",
      api_token: "secret",
      meta: { z: 2, a: "comma,value" },
    }]]);

    expect(result.output).toBe(
      "id,name,api_token,meta\r\n" +
      "1,\"'=HYPERLINK(\"\"https://bad\"\")\nnext\",••••,\"{\"\"a\"\":\"\"comma,value\"\",\"\"z\"\":2}\"\r\n",
    );
    expect(result.summary).toMatchObject({ rowsWritten: 1, maskedColumns: ["api_token"] });
    expect(result.summary.bytesWritten).toBe(Buffer.byteLength(result.output));
  });

  test("streams JSON arrays across batches in catalog column order", async () => {
    const result = await render("json", [
      [{ id: 1, name: "one", api_token: null, meta: { b: 2, a: 1 } }],
      [{ id: 2, name: "two", api_token: "secret", meta: undefined }],
    ]);

    expect(result.output).toBe(
      '[{"id":1,"name":"one","api_token":null,"meta":{"a":1,"b":2}},' +
      '{"id":2,"name":"two","api_token":"••••","meta":null}]\n',
    );
    expect(result.summary.rowsWritten).toBe(2);
  });

  test("hardens every spreadsheet formula prefix", () => {
    expect(["=1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd"].map(csvCell)).toEqual([
      "'=1",
      "'+1",
      "'-1",
      "'@SUM(A1)",
      "'\tcmd",
      "\"'\rcmd\"",
    ]);
    expect(csvCell(-42)).toBe("-42");
  });

  test("stops between streamed rows when cancelled", async () => {
    const controller = new AbortController();
    let writes = 0;
    await expect(writeDatabaseExport(
      {
        async write() {
          writes += 1;
          if (writes === 2) controller.abort();
        },
      },
      "json",
      columns,
      (async function* stream() {
        yield [
          { id: 1, name: "one", api_token: null, meta: null },
          { id: 2, name: "two", api_token: null, meta: null },
        ];
      })(),
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(writes).toBe(2);
  });
});
