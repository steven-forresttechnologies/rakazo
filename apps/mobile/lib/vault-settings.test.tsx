// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Vault from "../app/(settings)/vault";

type Credential = {
  name: string;
  origin: string;
  auth: { type: string } | null;
  createdAt: string;
  updatedAt: string;
};
const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  spaceId: undefined as string | undefined,
  credentials: [] as Credential[],
}));
const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  captureApiRequestContext: async (spaceId: string) => ({ headers: { space: spaceId } }),
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ spaceId: state.spaceId }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: element("p"),
  View: element("div"),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: element("div") }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    actions,
    onPressAction,
    title,
    children,
  }: {
    actions: { id: string; title: string; attributes?: { destructive?: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    title: string;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      { "aria-label": title },
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "data-destructive": action.attributes?.destructive === true,
            onClick: () => onPressAction({ nativeEvent: { event: action.id } }),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("../components/load-failure", () => ({
  LoadFailure: ({ message, onRetry }: { message: string; onRetry: () => void }) =>
    createElement("button", { type: "button", onClick: onRetry }, `${message} Retry`),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: element("section"),
  SettingsRow: ({
    title,
    detail,
    onPress,
  }: {
    title: string;
    detail?: string;
    onPress?: () => void;
  }) =>
    onPress
      ? createElement("button", { type: "button", onClick: onPress }, title)
      : createElement("span", null, detail ? `${title}: ${detail}` : title),
}));
// The sheet is covered by its own test; here it reports what it was opened for and saves a fixed
// destination, rejecting the way the real sheet expects when the save fails.
vi.mock("../components/vault-credential-sheet", () => ({
  VaultCredentialSheet: ({
    replacing,
    onClose,
    onSave,
  }: {
    replacing: Credential | null;
    onClose: () => void;
    onSave: (destination: unknown, value: string) => Promise<void>;
  }) => {
    const [failed, setFailed] = useState(false);
    return createElement(
      "dialog",
      { open: true, "aria-label": replacing ? `Replace ${replacing.name}` : "Add" },
      createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            onSave(
              replacing
                ? { name: replacing.name, origin: replacing.origin, auth: replacing.auth }
                : { name: "netbird-key", auth: { type: "command" } },
              "example-value",
            ).then(onClose, () => setFailed(true)),
        },
        "Save",
      ),
      failed ? "Failed" : null,
    );
  },
}));

const credential = (change: Partial<Credential>): Credential => ({
  name: "github",
  origin: "https://api.github.com",
  auth: { type: "bearer" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...change,
});

let root: Root;
let container: HTMLDivElement;
const rows = () => [...container.querySelectorAll("span")].map((node) => node.textContent);
const button = (label: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll("button")].find((node) => node.textContent === label);
const menu = (name: string) => container.querySelector(`[aria-label="${name}"]`)!;
type AlertButton = { text: string; style?: string; onPress?: () => void };
const alertButton = (text: string) =>
  (state.alert.mock.lastCall![2] as AlertButton[]).find((entry) => entry.text === text)!;

async function render() {
  await act(async () => root.render(createElement(Vault)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.spaceId = undefined;
  state.alert.mockReset();
  state.credentials = [
    credential({}),
    credential({ name: "netbird-key", origin: "", auth: { type: "command" } }),
  ];
  state.rpc.mockReset().mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    if (proc === "vault/list") return state.credentials;
    if (proc === "vault/put") {
      const destination = input.destination as Credential;
      return credential({ ...destination, origin: destination.origin ?? "" });
    }
    if (proc === "vault/remove") return { ok: true };
    throw new Error(`Unexpected RPC: ${proc}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lists the account vault with each credential's site or command variable", async () => {
  await render();
  expect(state.rpc).toHaveBeenCalledWith("vault/list", { scope: "account" });
  expect(rows()).toEqual([
    "github: https://api.github.com",
    "netbird-key: Command variable $NETBIRD_KEY",
  ]);
  expect(button("Add credential")).toBeDefined();
});

it("edits a Space's own vault through that Space", async () => {
  state.spaceId = "space-work";
  await render();
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/list",
    { scope: "space" },
    { requestContext: { headers: { space: "space-work" } } },
  );

  await act(async () => button("Add credential")!.click());
  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(state.rpc).toHaveBeenCalledWith(
    "vault/put",
    {
      scope: "space",
      destination: { name: "netbird-key", auth: { type: "command" } },
      value: "example-value",
    },
    { requestContext: { headers: { space: "space-work" } } },
  );
});

it("adds a credential and closes the form once saved", async () => {
  state.credentials = [credential({})];
  await render();
  await act(async () => button("Add credential")!.click());
  expect(container.querySelector('dialog[aria-label="Add"]')).not.toBeNull();

  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(container.querySelector("dialog")).toBeNull();
  expect(rows()).toEqual([
    "github: https://api.github.com",
    "netbird-key: Command variable $NETBIRD_KEY",
  ]);
});

it("keeps the form open when saving fails", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Add credential")!.click());
  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(container.querySelector("dialog")?.textContent).toContain("Failed");
});

it("replaces a credential's value from its menu, keeping its site and type", async () => {
  await render();
  await act(async () => button("Replace value", menu("github"))!.click());
  expect(container.querySelector('dialog[aria-label="Replace github"]')).not.toBeNull();

  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(state.rpc).toHaveBeenLastCalledWith("vault/put", {
    scope: "account",
    destination: { name: "github", origin: "https://api.github.com", auth: { type: "bearer" } },
    value: "example-value",
  });
  expect(container.querySelector("dialog")).toBeNull();
});

it("removes a credential only once the destructive alert is confirmed", async () => {
  await render();
  const remove = button("Remove", menu("github"))!;
  expect(remove.dataset.destructive).toBe("true");

  await act(async () => remove.click());
  expect(state.alert).toHaveBeenCalledWith("Remove github?", undefined, expect.any(Array));
  expect(alertButton("Remove").style).toBe("destructive");
  await act(async () => alertButton("Cancel").onPress?.());
  expect(state.rpc).not.toHaveBeenCalledWith("vault/remove", expect.anything());

  await act(async () => alertButton("Remove").onPress?.());
  expect(state.rpc).toHaveBeenCalledWith("vault/remove", { scope: "account", name: "github" });
  expect(rows()).toEqual(["netbird-key: Command variable $NETBIRD_KEY"]);
});

it("offers only removal for a credential whose settings can't be read", async () => {
  state.credentials = [credential({ name: "legacy", auth: null })];
  await render();
  expect(button("Replace value", menu("legacy"))).toBeUndefined();
  expect(button("Remove", menu("legacy"))).toBeDefined();
});

it("shows an error when removing fails and keeps the credential", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Remove", menu("github"))!.click());
  await act(async () => alertButton("Remove").onPress?.());
  expect(container.textContent).toContain("Could not remove the credential");
  expect(rows()).toContain("github: https://api.github.com");
});

it("offers a retry when the vault fails to load", async () => {
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await render();
  expect(button("Add credential")).toBeUndefined();

  await act(async () => button("Something went wrong. Try again. Retry")!.click());
  expect(rows()).toHaveLength(2);
});

it("clears a failed removal's error once a later save succeeds", async () => {
  await render();
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Remove", menu("github"))!.click());
  await act(async () => alertButton("Remove").onPress?.());
  expect(container.textContent).toContain("Could not remove the credential");

  await act(async () => button("Add credential")!.click());
  await act(async () => button("Save", container.querySelector("dialog")!)!.click());
  expect(container.textContent).not.toContain("Could not remove the credential");
});
