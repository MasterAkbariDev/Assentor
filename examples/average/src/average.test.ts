import assert from "node:assert/strict";
import { test } from "node:test";
import { average } from "./average.js";

test("average of positive numbers", () => {
  assert.equal(average([2, 4, 6]), 4);
});

test("average of a single value", () => {
  assert.equal(average([10]), 10);
});

test("average of an empty array is 0", () => {
  assert.equal(average([]), 0);
});
