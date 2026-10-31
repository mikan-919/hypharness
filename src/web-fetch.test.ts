import { expect, test } from "bun:test";
import { fetchPublicPage, publicAddress } from "./web-fetch.ts";

test("fetch validates every resolved address and every redirect before connecting", async () => {
  expect(publicAddress("127.0.0.1")).toBe(false);
  expect(publicAddress("10.1.2.3")).toBe(false);
  expect(publicAddress("::1")).toBe(false);
  expect(publicAddress("::ffff:127.0.0.1")).toBe(false);
  expect(publicAddress("64:ff9b::a00:1")).toBe(false);
  expect(publicAddress("2002:0a00:0001::")).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  let calls = 0;
  const resolve = async (host: string) => [{ address: host === "private.example" ? "127.0.0.1" : "8.8.8.8", family: 4 }];
  const get = async () => { calls++; return { status: 302, location: "http://private.example/", contentType: "", body: "" }; };
  await expect(fetchPublicPage("https://public.example/", resolve, get)).rejects.toThrow("Private");
  expect(calls).toBe(1);
  await expect(fetchPublicPage("file:///etc/passwd", resolve, get)).rejects.toThrow("HTTP");
});

test("fetch extracts text and removes scripts without making network calls", async () => {
  const page = await fetchPublicPage("https://public.example/", async () => [{ address: "8.8.8.8", family: 4 }], async () => ({ status: 200, contentType: "text/html", body: "<p>Hello <b>world</b></p><script>hidden()</script>" }));
  expect(page.text).toContain("Hello world");
  expect(page.text).not.toContain("hidden");
});
