import { beforeEach, expect } from "vitest";

// A live test must never pass vacuously: every non-skipped test has to assert something.
beforeEach(() => {
  expect.hasAssertions();
});
