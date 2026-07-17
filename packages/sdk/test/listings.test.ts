import { describe, it } from "vitest";

describe("transport rawQuerySuffix", () => {
  // The transport (RequestSpec.rawQuerySuffix + NeweggHttpClient.executeOnce) is internal,
  // so it can only be exercised through a public API. Task 3 activates this test via
  // `client.listings.create`, which submits the item-creation feed with the bare `&v2`
  // template flag. createMockFetch (packages/sdk/src/testing/index.ts) accepts string inputs,
  // and `new URL(string)` preserves a bare `&v2` in `.search`, so the eventual assertions are:
  // the recorded call's `url.search` contains "&v2" and does NOT contain "v2=".
  it.todo("appends a bare &v2 flag (not v2=) to the request URL");
});
