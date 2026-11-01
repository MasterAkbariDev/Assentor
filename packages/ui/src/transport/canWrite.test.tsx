// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { mockTransport } from "./mock.js";
import { TransportProvider, useCanWrite } from "./context.js";

afterEach(() => cleanup());

function Probe() {
  return <p>{useCanWrite() ? "can write" : "read only"}</p>;
}

describe("useCanWrite", () => {
  it("follows the transport: read-only when not granted, and false while the link is down", async () => {
    const rw = mockTransport();
    const { getByText, unmount } = render(<TransportProvider transport={rw}><Probe /></TransportProvider>);
    expect(getByText("can write")).toBeTruthy();
    act(() => rw.drop());
    expect(getByText("read only")).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(getByText("can write")).toBeTruthy();
    unmount();
    const ro = render(<TransportProvider transport={mockTransport({ canWrite: false })}><Probe /></TransportProvider>);
    expect(ro.getByText("read only")).toBeTruthy();
  });
});
