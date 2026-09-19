import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeT } from "../lib/i18n";
import type { Response } from "../lib/types";
import { ResponsePanel } from "./ResponsePanel";

const t = makeT("zh");

const response: Response = {
  status: 200,
  statusText: "OK",
  proto: "HTTP/1.1",
  headers: [{ key: "Set-Cookie", value: "sid=s1; Path=/" }],
  contentType: "application/json",
  body: '{"ok":true}',
  bodyBinary: false,
  truncated: false,
  sizeBytes: 11,
  timeMs: 12,
  timing: { dnsMs: 0, connectMs: 0, tlsMs: 0, firstByteMs: 0, downloadMs: 0 },
  url: "https://api.example.com/me",
  cookies: [
    { name: "sid", value: "s1", from: "jar" },
    { name: "theme", value: "dark", from: "header" },
  ],
};

function open(props: Partial<Parameters<typeof ResponsePanel>[0]> = {}) {
  render(
    <ResponsePanel t={t} response={response} sending={false} {...props} />,
  );
}

describe("the cookie tab", () => {
  it("lists what the request carried and where each cookie came from", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "Cookie · 2" }));
    expect(screen.getByText("sid")).toBeInTheDocument();
    expect(screen.getByText("s1")).toBeInTheDocument();
    // A session the connection keeps, against one typed into this request.
    expect(screen.getByText("会话")).toBeInTheDocument();
    expect(screen.getByText("请求头")).toBeInTheDocument();
  });

  it("clears the stored cookies from the tab", async () => {
    const onClearCookies = vi.fn();
    open({ onClearCookies });
    await userEvent.click(screen.getByRole("button", { name: "Cookie · 2" }));
    await userEvent.click(screen.getByTitle("清除已保存的 Cookie"));
    expect(onClearCookies).toHaveBeenCalled();
  });

  it("says so when a request carried none", async () => {
    open({ response: { ...response, cookies: undefined } });
    await userEvent.click(screen.getByRole("button", { name: "Cookie · 0" }));
    expect(screen.getByText("本次请求未携带 Cookie")).toBeInTheDocument();
  });
});
