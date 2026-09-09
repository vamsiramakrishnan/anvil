// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useLoad } from "./hooks.js";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("never renders a previous bundle under a newly selected bundle", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const { result, rerender } = renderHook(
    ({ id }) => useLoad(() => (id === "first" ? first.promise : second.promise), [id]),
    { initialProps: { id: "first" } },
  );
  rerender({ id: "second" });
  expect(result.current.data).toBeUndefined();
  await act(async () => second.resolve("second bundle"));
  expect(result.current.data).toBe("second bundle");
  await act(async () => first.resolve("first bundle"));
  expect(result.current.data).toBe("second bundle");
});

it("only the newest overlapping refresh can publish its result", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  let calls = 0;
  const { result } = renderHook(() =>
    useLoad(() => (++calls === 1 ? first.promise : second.promise), []),
  );
  let refresh!: Promise<void>;
  act(() => {
    refresh = result.current.reload();
  });
  await act(async () => {
    second.resolve("new");
    await refresh;
  });
  await act(async () => first.resolve("old"));
  expect(result.current.data).toBe("new");
});
