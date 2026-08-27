// Checks for the only logic in restore.ts that is genuinely new — the
// gunzip half of the storage round trip, the concurrency pool, and the
// input guards. Parsing and normalization are already covered by the
// function's own tests.
import { assert, assertEquals } from "@std/assert";
import { gunzip, listDay, pool, VALID_DAY, VALID_TABLE } from "./restore.ts";

/** Same compression the storage sink applies (sinks/storage.ts). */
async function gzipBlob(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Blob([await new Response(stream).arrayBuffer()]);
}

Deno.test("gunzip reverses the storage sink's gzip", async () => {
  const body = '{"id":"a","timestamp":1723478400100}\n{"id":"b"}\n';
  assertEquals(await gunzip(await gzipBlob(body)), body);
});

Deno.test("gunzip handles a multi-line ndjson body of realistic size", async () => {
  const body = Array.from(
    { length: 500 },
    (_, i) => JSON.stringify({ id: `id-${i}`, message: "x".repeat(200) }),
  ).join("\n");
  assertEquals(await gunzip(await gzipBlob(body)), body);
});

Deno.test("pool processes every item and respects the concurrency cap", async () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const seen: number[] = [];
  let inFlight = 0, peak = 0;

  await pool(items, 8, async (item) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    seen.push(item);
    inFlight--;
  });

  assertEquals(seen.length, items.length);
  assertEquals([...seen].sort((a, b) => a - b), items);
  assert(peak <= 8, `peak concurrency ${peak} exceeded the cap`);
});

Deno.test("pool copes with an empty list", async () => {
  let calls = 0;
  await pool([], 8, () => {
    calls++;
    return Promise.resolve();
  });
  assertEquals(calls, 0);
});

Deno.test("listDay pages past the first 1000 objects", async () => {
  // storage.list() caps at 1000 per call; a single-page implementation
  // would silently restore only the first page.
  const pages = [
    Array.from({ length: 1000 }, (_, i) => ({ name: `${i}.ndjson.gz` })),
    [{ name: "extra.ndjson.gz" }, { name: "notes.txt" }],
  ];
  const calls: number[] = [];
  const storage = {
    // deno-lint-ignore no-explicit-any
    list(_folder: string, opts: any) {
      calls.push(opts.offset);
      const page = pages.shift() ?? [];
      return Promise.resolve({ data: page, error: null });
    },
  };

  const keys = await listDay(storage, "vercel-drain", "2026-03-03");

  assertEquals(keys.length, 1001, "should include the second page");
  assertEquals(calls, [0, 1000], "should request a second page at offset 1000");
  assert(
    keys.every((k) => k.startsWith("vercel-drain/2026-03-03/")),
    "keys should be fully qualified",
  );
  assert(!keys.some((k) => k.endsWith(".txt")), "non-archive files filtered");
});

Deno.test("listDay surfaces storage errors instead of returning partial data", async () => {
  const storage = {
    list: () => Promise.resolve({ data: null, error: { message: "denied" } }),
  };
  let threw = false;
  try {
    await listDay(storage, "vercel-drain", "2026-03-03");
  } catch (error) {
    threw = true;
    assert(String(error).includes("denied"));
  }
  assert(threw, "expected listDay to throw");
});

Deno.test("input guards", () => {
  assert(VALID_DAY.test("2026-03-03"));
  assert(!VALID_DAY.test("2026-3-3"));
  assert(!VALID_DAY.test("../../etc"));

  assert(VALID_TABLE.test("drain.vercel_logs_restore"));
  assert(!VALID_TABLE.test("drain.vercel_logs; drop table x"));
  assert(!VALID_TABLE.test("vercel_logs_restore"));
});
