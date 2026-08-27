// Covers the pure logic in retention.ts. The SQL in inventory() is
// exercised against a real Postgres by the migrations job, not here.
import { assertEquals } from "@std/assert";
import { formatBytes, parseRetention } from "./retention.ts";

Deno.test("parseRetention reads the named-argument form 0003 schedules", () => {
  assertEquals(
    parseRetention(
      "select drain.vercel_logs_maintenance(retention_days => 14)",
    ),
    14,
  );
  assertEquals(
    parseRetention(" select drain.vercel_logs_maintenance(retention_days=>7) "),
    7,
  );
});

Deno.test("parseRetention also reads the positional form", () => {
  assertEquals(parseRetention("select drain.vercel_logs_maintenance(30)"), 30);
});

Deno.test("parseRetention returns null when it cannot tell", () => {
  assertEquals(parseRetention("select drain.vercel_logs_maintenance()"), null);
  assertEquals(parseRetention("select something_else()"), null);
});

Deno.test("formatBytes scales and stays readable", () => {
  assertEquals(formatBytes(0), "0 B");
  assertEquals(formatBytes(512), "512 B");
  assertEquals(formatBytes(1024), "1.0 KB");
  assertEquals(formatBytes(1536), "1.5 KB");
  assertEquals(formatBytes(1024 * 1024), "1.0 MB");
  assertEquals(formatBytes(1024 * 1024 * 1024 * 3.5), "3.5 GB");
  // Past 10 the decimal is noise.
  assertEquals(formatBytes(1024 * 1024 * 42), "42 MB");
});
