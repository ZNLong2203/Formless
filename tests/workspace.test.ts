import { describe, expect, it } from "vitest";
import { resolveWorkspace, WORKSPACE_COOKIE } from "@/lib/workspace";

function requestWith(cookie?: string): Request {
  return new Request("https://example.test/api/state", {
    headers: cookie ? { cookie } : {},
  });
}

/**
 * Workspaces are the only thing standing between one visitor's customer emails
 * and the next visitor who opens the link.
 */
describe("resolveWorkspace", () => {
  it("mints an id when the visitor has no cookie", () => {
    const workspace = resolveWorkspace(requestWith());
    expect(workspace.isNew).toBe(true);
    expect(workspace.id).toMatch(/^ws_[0-9a-f]{32}$/);
  });

  it("mints a different id for each new visitor", () => {
    const a = resolveWorkspace(requestWith()).id;
    const b = resolveWorkspace(requestWith()).id;
    expect(a).not.toBe(b);
  });

  it("keeps an id the visitor already carries", () => {
    const existing = `ws_${"a".repeat(32)}`;
    const workspace = resolveWorkspace(requestWith(`${WORKSPACE_COOKIE}=${existing}`));
    expect(workspace).toEqual({ id: existing, isNew: false });
  });

  it("finds its cookie among others", () => {
    const existing = `ws_${"b".repeat(32)}`;
    const workspace = resolveWorkspace(
      requestWith(`theme=dark; ${WORKSPACE_COOKIE}=${existing}; other=1`),
    );
    expect(workspace.id).toBe(existing);
  });

  /** A hand-edited cookie must not become a way to read someone else's rows. */
  it("rejects a cookie that is not of our own shape", () => {
    for (const forged of ["", "nonsense", "ws_short", "ws_" + "Z".repeat(32), "../../etc"]) {
      const workspace = resolveWorkspace(requestWith(`${WORKSPACE_COOKIE}=${forged}`));
      expect(workspace.isNew).toBe(true);
      expect(workspace.id).not.toBe(forged);
    }
  });

  it("is unaffected by a cookie header it cannot parse", () => {
    const workspace = resolveWorkspace(requestWith("garbage-without-equals"));
    expect(workspace.isNew).toBe(true);
  });
});
