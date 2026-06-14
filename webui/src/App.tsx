import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import {
  AppShell,
  Burger,
  Center,
  CopyButton,
  Group,
  Loader,
  Select,
  Tabs,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { api, getStatus, postConfig, type StatusResp } from "./api";
import { Overview } from "./pages/Overview";
import { Holdings } from "./pages/Holdings";
import { Trade } from "./pages/Trade";
import { Automation } from "./pages/Automation";
import { Timeline } from "./pages/Timeline";
import { Strategy } from "./pages/Strategy";
import { Trades } from "./pages/Trades";
import { PnL } from "./pages/PnL";
import { Backtests } from "./pages/Backtests";
import { Execution } from "./pages/Execution";
import { Safety } from "./pages/Safety";
import { Approvals } from "./pages/Approvals";
import { Audit } from "./pages/Audit";
import { ConfigPage } from "./pages/Config";

// Chart pulls in lightweight-charts (~100 KB minified). Loading it lazily means the
// other 8 tabs paint without paying that cost on first load. Vite generates a separate
// chunk; the chunk is fetched on demand when the user clicks the Chart tab.
const Chart = lazy(() => import("./pages/Chart").then((m) => ({ default: m.Chart })));

const TABS = [
  { value: "overview", label: "Overview", el: Overview },
  { value: "holdings", label: "Holdings", el: Holdings },
  { value: "trade", label: "Trade", el: Trade },
  { value: "automation", label: "Automation", el: Automation },
  { value: "timeline", label: "Timeline", el: Timeline },
  { value: "strategy", label: "Strategy", el: Strategy },
  { value: "chart", label: "Chart", el: Chart },
  { value: "trades", label: "Trades", el: Trades },
  { value: "pnl", label: "PnL", el: PnL },
  { value: "backtests", label: "Backtests", el: Backtests },
  { value: "execution", label: "Execution", el: Execution },
  { value: "safety", label: "Safety", el: Safety },
  { value: "approvals", label: "Approvals", el: Approvals },
  { value: "audit", label: "Audit", el: Audit },
  { value: "config", label: "Config", el: ConfigPage },
];

function shortAddr(a: string) {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function App() {
  const [opened, { toggle }] = useDisclosure();
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Persist active tab in window.location.hash so a browser refresh keeps the user
  // on the page they were looking at. Validates against TABS so a stale or garbage
  // hash gracefully falls back to "overview".
  const [tab, setTab] = useState<string>(() => {
    const fromHash = window.location.hash.replace(/^#/, "");
    return TABS.some((t) => t.value === fromHash) ? fromHash : "overview";
  });
  useEffect(() => {
    if (window.location.hash.replace(/^#/, "") !== tab) {
      window.history.replaceState(null, "", `#${tab}`);
    }
  }, [tab]);
  // Honor browser back/forward navigation between tabs.
  useEffect(() => {
    const onHash = () => {
      const fromHash = window.location.hash.replace(/^#/, "");
      if (TABS.some((t) => t.value === fromHash)) setTab(fromHash);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [switching, setSwitching] = useState<"chain" | "account" | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getStatus();
      setStatus(s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  async function switchChain(name: string | null) {
    if (!name || !status || name === status.activeChain) return;
    setSwitching("chain");
    try {
      await postConfig("activeChain", name);
      await refreshStatus();
      notifications.show({ color: "blue", message: `Active chain → ${name}` });
    } catch (e) {
      notifications.show({ color: "red", message: (e as Error).message });
    } finally {
      setSwitching(null);
    }
  }

  async function switchAccount(label: string | null) {
    if (!label || !status || label === status.activeAccount) return;
    setSwitching("account");
    try {
      await api.post("/api/accounts/use", { label });
      await refreshStatus();
      notifications.show({ color: "blue", message: `Active account → ${label}` });
    } catch (e) {
      notifications.show({ color: "red", message: (e as Error).message });
    } finally {
      setSwitching(null);
    }
  }

  if (error) {
    return (
      <div style={{ padding: 30, color: "#f85149" }}>
        Failed to load: {error}. Check the server console for the bootstrap URL with <code>?token=…</code>.
      </div>
    );
  }
  if (!status) {
    return (
      <Group justify="center" p="xl">
        <Loader size="sm" /> <Text>Loading tradekit…</Text>
      </Group>
    );
  }

  const ActiveTab = TABS.find((t) => t.value === tab)?.el ?? Overview;
  // Build account list. If no HD accounts are present, the server returns [] for accounts
  // and reports activeAccount="keystore"; show a single "keystore" option so the switcher
  // is non-empty but disabled.
  const accountOptions =
    status.accounts.length > 0
      ? status.accounts.map((a) => ({ value: a.label, label: a.label }))
      : [{ value: "keystore", label: "keystore (single-key)" }];

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 0, breakpoint: "sm", collapsed: { mobile: !opened, desktop: true } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" gap="md" wrap="nowrap">
          <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
          <Title order={4} c="blue.4" style={{ letterSpacing: 0.5 }}>
            tradekit
          </Title>
          <Group gap="xs" visibleFrom="sm" wrap="nowrap" style={{ flex: 1 }}>
            <Select
              size="xs"
              w={150}
              data={accountOptions}
              value={status.activeAccount}
              onChange={switchAccount}
              disabled={status.accounts.length <= 1 || switching === "account"}
              aria-label="Active account"
              comboboxProps={{ withinPortal: true }}
            />
            <Select
              size="xs"
              w={130}
              data={status.chains}
              value={status.activeChain}
              onChange={switchChain}
              disabled={switching === "chain"}
              aria-label="Active chain"
              comboboxProps={{ withinPortal: true }}
            />
            {status.address && (
              <CopyButton value={status.address}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? "Copied!" : "Copy full address"} withArrow>
                    <UnstyledButton onClick={copy}>
                      <Text c="dimmed" size="xs" ff="monospace">
                        {shortAddr(status.address!)}
                      </Text>
                    </UnstyledButton>
                  </Tooltip>
                )}
              </CopyButton>
            )}
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Tabs value={tab} onChange={(v) => v && setTab(v)} keepMounted={false}>
          <Tabs.List>
            {TABS.map((t) => (
              <Tabs.Tab key={t.value} value={t.value}>
                {t.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <Tabs.Panel value={tab} pt="md">
            <Suspense fallback={<Center p="xl"><Loader size="sm" /></Center>}>
              <ActiveTab status={status} onStatusChange={refreshStatus} />
            </Suspense>
          </Tabs.Panel>
        </Tabs>
      </AppShell.Main>
    </AppShell>
  );
}
