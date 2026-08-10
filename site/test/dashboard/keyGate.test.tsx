// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import KeyGate from "@/components/dashboard/KeyGate";

// This repo's vitest.config.ts does not set `globals: true`, so Testing
// Library never registers its own afterEach and renders would otherwise pile
// up in document.body — every query after the first test would find duplicates.
afterEach(cleanup);

const validKey = `ut_live_${"a".repeat(48)}`;

describe("KeyGate", () => {
  test("rejects a malformed key without calling back", async () => {
    const onKey = vi.fn();
    render(<KeyGate onKey={onKey} onSample={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "not-a-key" } });
    fireEvent.click(screen.getByRole("button", { name: /view my data/i }));

    expect(onKey).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/ut_live_/i);
  });

  test("accepts a well-formed key", async () => {
    const onKey = vi.fn();
    render(<KeyGate onKey={onKey} onSample={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: validKey } });
    fireEvent.click(screen.getByRole("button", { name: /view my data/i }));

    expect(onKey).toHaveBeenCalledWith(validKey);
  });

  test("offers a sample-data path", async () => {
    const onSample = vi.fn();
    render(<KeyGate onKey={vi.fn()} onSample={onSample} />);
    fireEvent.click(screen.getByRole("button", { name: /sample data/i }));
    expect(onSample).toHaveBeenCalled();
  });

  test("the key input is a password field so it is not shoulder-readable", () => {
    render(<KeyGate onKey={vi.fn()} onSample={vi.fn()} />);
    expect(screen.getByLabelText(/api key/i).getAttribute("type")).toBe("password");
  });

  test("shows a rejection notice when told the key was refused", () => {
    render(<KeyGate onKey={vi.fn()} onSample={vi.fn()} rejected />);
    expect(screen.getByRole("alert").textContent).toMatch(/rejected/i);
  });
});
