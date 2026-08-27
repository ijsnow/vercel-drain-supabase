import { assertEquals } from "./asserts.ts";
import { parseDrainBody } from "../parse.ts";

const fixture = (name: string): Promise<string> =>
  Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

Deno.test("parses ndjson fixture", async () => {
  const { events, malformed } = parseDrainBody(await fixture("lambda.ndjson"));
  assertEquals(events.length, 4);
  assertEquals(malformed, 0);
  assertEquals(
    (events[0] as { source: string }).source,
    "lambda",
  );
});

Deno.test("parses json-array fixture", async () => {
  const { events, malformed } = parseDrainBody(
    await fixture("json-array.json"),
  );
  assertEquals(events.length, 2);
  assertEquals(malformed, 0);
});

Deno.test("counts malformed lines without dropping good ones", async () => {
  const { events, malformed } = parseDrainBody(
    await fixture("malformed.ndjson"),
  );
  // 4 parseable JSON values (one of which is later rejected by
  // normalization for having no id/timestamp), 2 unparseable lines.
  assertEquals(events.length, 3);
  assertEquals(malformed, 2);
});

Deno.test("empty body and empty array yield no events", () => {
  assertEquals(parseDrainBody(""), { events: [], malformed: 0 });
  assertEquals(parseDrainBody("   \n  "), { events: [], malformed: 0 });
  assertEquals(parseDrainBody("[]"), { events: [], malformed: 0 });
});

Deno.test("single json object body yields one event", () => {
  const { events, malformed } = parseDrainBody('{"id":"a","timestamp":1}');
  assertEquals(events.length, 1);
  assertEquals(malformed, 0);
});

Deno.test("body starting with [ that is not valid json falls back to ndjson", () => {
  const { events, malformed } = parseDrainBody('[not json\n{"id":"a"}');
  assertEquals(events.length, 1);
  assertEquals(malformed, 1);
});
