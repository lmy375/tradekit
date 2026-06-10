// Automation page — the engine's situational view in the browser.
//
// Read-only by design (mirrors the webAutomation.ts route contract):
// engine liveness + lock, currently-firing alerts, the three
// primitive tables with decision-journal drill-in (the rebalance
// rows render drift as a progress bar toward the threshold), and the
// paper book. Auto-refreshes every 15s.

import { useCallback, useEffect, useState } from "react";
import {
  Accordion,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Progress,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  getAlerts,
  getAutoOrderDetail,
  getAutoOrders,
  getAutoPlaybooks,
  getAutoRebalance,
  getAutoRebalanceDetail,
  getAutoScheduleDetail,
  getAutoSchedules,
  getEngine,
  getPaper,
  getRunway,
  type AlertsResp,
  type AutoOrderRow,
  type AutoPlaybookRow,
  type AutoRebalanceRow,
  type AutoScheduleRow,
  type EngineResp,
  type OrderJournalRow,
  type PageProps,
  type PaperResp,
  type RunwayResp,
  type RebalanceJournalRow,
  type ScheduleJournalRow,
} from "../api";

const REFRESH_MS = 15_000;

function ago(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(secs)) return iso;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function until(iso: string): string {
  const secs = Math.floor((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(secs)) return iso;
  if (secs <= 0) return "due now";
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `in ${Math.floor(secs / 3600)}h`;
  return `in ${Math.floor(secs / 86400)}d`;
}

function statusBadge(s: string) {
  const color =
    s === "active" ? "green" :
    s === "paused" ? "yellow" :
    s === "filled" || s === "completed" || s === "deployed" ? "blue" :
    s === "failed" ? "red" : "gray";
  return <Badge size="xs" color={color} variant="light">{s}</Badge>;
}

function paperBadge(paper: number) {
  return paper === 1 ? <Badge size="xs" color="grape" variant="light">paper</Badge> : null;
}

// ── engine bar ───────────────────────────────────────────────

function EngineBar({ engine }: { engine: EngineResp }) {
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" wrap="wrap">
        <Group gap="sm">
          <Badge color={engine.running ? "green" : "red"} variant="filled">
            engine {engine.running ? "running" : "down"}
          </Badge>
          {engine.lock.active && (
            <Tooltip label={`locked by ${engine.lock.lockedBy ?? "?"} — ${engine.lock.reason ?? "(no reason)"}`}>
              <Badge color="red" variant="light">🔒 locked</Badge>
            </Tooltip>
          )}
          {engine.status && (
            <Text size="xs" c="dimmed">
              pid {engine.status.pid} · updated {ago(engine.status.updatedAt)}
            </Text>
          )}
        </Group>
        {engine.status && (
          <Group gap="xs">
            {engine.status.workers.map((w) => (
              <Tooltip key={w.name} label={`${w.ticks} ticks · ${w.failures} failures · last ${ago(w.lastTickAt)}`}>
                <Badge size="xs" variant="dot" color={w.failures > 0 ? "yellow" : "teal"}>
                  {w.name}
                </Badge>
              </Tooltip>
            ))}
          </Group>
        )}
      </Group>
    </Card>
  );
}

// ── alerts strip ─────────────────────────────────────────────

function AlertsStrip({ alerts }: { alerts: AlertsResp }) {
  if (alerts.active.length === 0 && alerts.history.length === 0) return null;
  return (
    <Card withBorder padding="sm">
      <Stack gap={6}>
        {alerts.active.length > 0 ? (
          <Group gap="xs">
            <Badge color="red" variant="filled">{alerts.active.length} alert{alerts.active.length === 1 ? "" : "s"} firing</Badge>
            {alerts.active.slice(0, 6).map((a) => (
              <Badge key={`${a.tag}/${a.rule_type}`} color="red" variant="light" size="sm">
                {a.tag} / {a.rule_type}
              </Badge>
            ))}
          </Group>
        ) : (
          <Group gap="xs">
            <Badge color="green" variant="light">no active alerts</Badge>
          </Group>
        )}
        {alerts.history.length > 0 && (
          <Text size="xs" c="dimmed">
            recent: {alerts.history.slice(0, 5).map((h) => `${h.event === "fired" ? "🔴" : "🟢"} ${h.tag}/${h.rule_type} ${ago(h.at)}`).join("  ·  ")}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

// ── journal renderers (drill-in) ─────────────────────────────

function OrderJournal({ rows }: { rows: OrderJournalRow[] }) {
  if (rows.length === 0) return <Text size="xs" c="dimmed">No journal entries (enable engine.orderJournal for forensic tracking).</Text>;
  return (
    <Stack gap={2}>
      {rows.slice(0, 10).map((r, i) => (
        <Text key={i} size="xs" ff="monospace">
          {r.checked_at}  {r.decision}
          {r.price_usd != null ? `  @$${r.price_usd}` : ""}
          {r.water_mark_usd != null ? `  hwm $${r.water_mark_usd}` : ""}
          {r.notes ? `  — ${r.notes.slice(0, 60)}` : ""}
        </Text>
      ))}
    </Stack>
  );
}

function ScheduleJournal({ rows }: { rows: ScheduleJournalRow[] }) {
  if (rows.length === 0) return <Text size="xs" c="dimmed">No journal entries (enable engine.scheduleJournal).</Text>;
  return (
    <Stack gap={2}>
      {rows.slice(0, 10).map((r, i) => (
        <Text key={i} size="xs" ff="monospace">
          {r.checked_at}  {r.decision}
          {r.run_number != null ? `  run #${r.run_number}` : ""}
          {r.error_code ? `  [${r.error_code}]` : ""}
          {r.notes ? `  — ${r.notes.slice(0, 60)}` : ""}
        </Text>
      ))}
    </Stack>
  );
}

function RebalanceJournal({ rows }: { rows: RebalanceJournalRow[] }) {
  if (rows.length === 0) return <Text size="xs" c="dimmed">No journal entries (enable engine.rebalanceJournal for the drift history).</Text>;
  return (
    <Stack gap={2}>
      {rows.slice(0, 10).map((r, i) => (
        <Text key={i} size="xs" ff="monospace">
          {r.checked_at}  {r.decision}
          {r.max_drift_pct != null ? `  drift ${r.max_drift_pct.toFixed(2)}%${r.threshold_pct != null ? `/${r.threshold_pct}%` : ""}` : ""}
          {r.executed_count != null ? `  legs ${r.executed_count} ok` : ""}
          {r.error_code ? `  [${r.error_code}]` : ""}
        </Text>
      ))}
    </Stack>
  );
}

// ── page ─────────────────────────────────────────────────────

export function Automation({ status: _status }: PageProps) {
  const [engine, setEngine] = useState<EngineResp | null>(null);
  const [alerts, setAlerts] = useState<AlertsResp | null>(null);
  const [orders, setOrders] = useState<AutoOrderRow[] | null>(null);
  const [schedules, setSchedules] = useState<AutoScheduleRow[] | null>(null);
  const [plans, setPlans] = useState<AutoRebalanceRow[] | null>(null);
  const [playbooks, setPlaybooks] = useState<AutoPlaybookRow[] | null>(null);
  const [paper, setPaper] = useState<PaperResp | null>(null);
  const [runway, setRunway] = useState<RunwayResp | null>(null);
  const [runwayLoading, setRunwayLoading] = useState(false);
  const [runwayError, setRunwayError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [error, setError] = useState<string | null>(null);
  // Journal drill-in caches, keyed by "<kind>:<id>".
  const [journals, setJournals] = useState<Record<string, OrderJournalRow[] | ScheduleJournalRow[] | RebalanceJournalRow[]>>({});

  const refresh = useCallback(async () => {
    try {
      const [e, a, o, s, r, p, pb] = await Promise.all([
        getEngine(),
        getAlerts(),
        getAutoOrders(statusFilter),
        getAutoSchedules(statusFilter),
        getAutoRebalance(statusFilter),
        getPaper(),
        getAutoPlaybooks(),
      ]);
      setEngine(e); setAlerts(a); setOrders(o.orders); setSchedules(s.schedules);
      setPlans(r.plans); setPaper(p); setPlaybooks(pb.playbooks);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [statusFilter]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const loadJournal = useCallback(async (kind: "order" | "schedule" | "rebalance", id: number) => {
    const key = `${kind}:${id}`;
    if (journals[key]) return;
    try {
      const journal =
        kind === "order" ? (await getAutoOrderDetail(id)).journal :
        kind === "schedule" ? (await getAutoScheduleDetail(id)).journal :
        (await getAutoRebalanceDetail(id)).journal;
      setJournals((j) => ({ ...j, [key]: journal }));
    } catch {
      setJournals((j) => ({ ...j, [key]: [] }));
    }
  }, [journals]);

  const computeRunway = useCallback(async () => {
    setRunwayLoading(true);
    setRunwayError(null);
    try {
      setRunway(await getRunway(90));
    } catch (e) {
      setRunwayError((e as Error).message);
    } finally {
      setRunwayLoading(false);
    }
  }, []);

  if (error) return <Text c="red">Failed to load automation state: {error}</Text>;
  if (!engine || !alerts) return <Loader size="sm" />;

  const describeTrigger = (o: AutoOrderRow) =>
    o.trigger_type === "trailing"
      ? `trail ${o.trail_pct}%${o.water_mark_usd != null ? ` (hwm $${o.water_mark_usd})` : ""}`
      : `${o.trigger_type === "price_below" ? "≤" : "≥"} $${o.target_price_usd}`;

  const targets = (p: AutoRebalanceRow): string => {
    try {
      return (JSON.parse(p.targets_json) as { token: string; targetPct: number }[])
        .map((t) => `${t.token} ${t.targetPct}%`)
        .join(" / ");
    } catch {
      return "?";
    }
  };

  return (
    <Stack>
      <EngineBar engine={engine} />
      <AlertsStrip alerts={alerts} />

      <Group justify="space-between" align="center">
        <Title order={5}>Primitives</Title>
        <SegmentedControl
          size="xs"
          value={statusFilter}
          onChange={setStatusFilter}
          data={["active", "all"]}
        />
      </Group>

      <Card withBorder padding="sm">
        <Title order={6} mb="xs">Orders {orders ? `(${orders.length})` : ""}</Title>
        {!orders || orders.length === 0 ? (
          <Text size="xs" c="dimmed">none</Text>
        ) : (
          <Accordion variant="contained" chevronPosition="right" multiple>
            {orders.map((o) => (
              <Accordion.Item key={o.id} value={`order-${o.id}`}>
                <Accordion.Control onClick={() => loadJournal("order", o.id)}>
                  <Group gap="xs" wrap="nowrap">
                    <Text size="sm" ff="monospace">#{o.id}</Text>
                    {statusBadge(o.status)}
                    {paperBadge(o.paper)}
                    <Text size="sm">
                      {o.side} {o.base_amount ?? o.quote_amount} {o.base_symbol ?? "?"}/{o.quote_symbol ?? "?"} · {describeTrigger(o)}
                    </Text>
                    {o.on_fill_json && <Badge size="xs" variant="outline">↳ hook</Badge>}
                    {o.strategy && <Code fz={10}>{o.strategy}</Code>}
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <OrderJournal rows={(journals[`order:${o.id}`] ?? []) as OrderJournalRow[]} />
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
      </Card>

      <Card withBorder padding="sm">
        <Title order={6} mb="xs">Schedules {schedules ? `(${schedules.length})` : ""}</Title>
        {!schedules || schedules.length === 0 ? (
          <Text size="xs" c="dimmed">none</Text>
        ) : (
          <Accordion variant="contained" chevronPosition="right" multiple>
            {schedules.map((s) => (
              <Accordion.Item key={s.id} value={`sched-${s.id}`}>
                <Accordion.Control onClick={() => loadJournal("schedule", s.id)}>
                  <Group gap="xs" wrap="nowrap">
                    <Text size="sm" ff="monospace">#{s.id}</Text>
                    {statusBadge(s.status)}
                    {paperBadge(s.paper)}
                    <Text size="sm">
                      {s.name ?? "(unnamed)"} · {s.side} {s.base_amount ?? s.quote_amount} {s.base_symbol ?? "?"}/{s.quote_symbol ?? "?"} · runs {s.run_count}{s.max_runs != null ? `/${s.max_runs}` : ""}
                    </Text>
                    {s.on_fill_json && <Badge size="xs" variant="outline">↳ hook</Badge>}
                    <Text size="xs" c="dimmed">next {until(s.next_run_at)}</Text>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <ScheduleJournal rows={(journals[`schedule:${s.id}`] ?? []) as ScheduleJournalRow[]} />
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
      </Card>

      <Card withBorder padding="sm">
        <Title order={6} mb="xs">Rebalance plans {plans ? `(${plans.length})` : ""}</Title>
        {!plans || plans.length === 0 ? (
          <Text size="xs" c="dimmed">none</Text>
        ) : (
          <Accordion variant="contained" chevronPosition="right" multiple>
            {plans.map((p) => {
              const pctOfThreshold =
                p.last_run_max_drift_pct != null && p.drift_threshold_pct > 0
                  ? Math.min(100, (p.last_run_max_drift_pct / p.drift_threshold_pct) * 100)
                  : null;
              return (
                <Accordion.Item key={p.id} value={`reb-${p.id}`}>
                  <Accordion.Control onClick={() => loadJournal("rebalance", p.id)}>
                    <Group gap="xs" wrap="nowrap">
                      <Text size="sm" ff="monospace">#{p.id}</Text>
                      {statusBadge(p.status)}
                      {paperBadge(p.paper)}
                      <Text size="sm">{p.name ?? "(unnamed)"} · {targets(p)}</Text>
                      {pctOfThreshold != null && (
                        <Tooltip label={`last drift ${p.last_run_max_drift_pct!.toFixed(2)}% of ${p.drift_threshold_pct}% threshold`}>
                          <Progress
                            value={pctOfThreshold}
                            color={pctOfThreshold >= 80 ? "red" : pctOfThreshold >= 50 ? "yellow" : "teal"}
                            w={90}
                            size="sm"
                          />
                        </Tooltip>
                      )}
                      <Text size="xs" c="dimmed">next {until(p.next_run_at)}</Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <RebalanceJournal rows={(journals[`rebalance:${p.id}`] ?? []) as RebalanceJournalRow[]} />
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        )}
      </Card>

      <Group grow align="stretch">
        <Card withBorder padding="sm">
          <Title order={6} mb="xs">Playbooks {playbooks ? `(${playbooks.length})` : ""}</Title>
          {!playbooks || playbooks.length === 0 ? (
            <Text size="xs" c="dimmed">none deployed</Text>
          ) : (
            <Table fz="xs">
              <Table.Tbody>
                {playbooks.map((pb) => (
                  <Table.Tr key={pb.id}>
                    <Table.Td ff="monospace">#{pb.id}</Table.Td>
                    <Table.Td>{pb.name}</Table.Td>
                    <Table.Td>{statusBadge(pb.status)}</Table.Td>
                    <Table.Td c="dimmed">{pb.deployed_at ? ago(pb.deployed_at) : "—"}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>

        <Card withBorder padding="sm">
          <Title order={6} mb="xs">Paper book</Title>
          {!paper || (paper.balances.length === 0 && paper.pnl.length === 0) ? (
            <Text size="xs" c="dimmed">empty — seed with `tradekit paper deposit`</Text>
          ) : (
            <Stack gap={4}>
              {paper.balances.slice(0, 6).map((b, i) => (
                <Text key={i} size="xs" ff="monospace">
                  {b.account}@{b.chain}  {b.balance}  {b.token.slice(0, 10)}…
                </Text>
              ))}
              {paper.pnl.slice(0, 4).map((p) => (
                <Text key={p.strategy} size="xs">
                  <Code fz={10}>{p.strategy}</Code> {p.fills} fills · net {p.netQuote >= 0 ? "+" : ""}{p.netQuote.toFixed(2)}
                </Text>
              ))}
            </Stack>
          )}
        </Card>

        <Card withBorder padding="sm">
          <Group justify="space-between" mb="xs">
            <Title order={6}>Funding runway</Title>
            <Button size="compact-xs" variant="default" onClick={computeRunway} loading={runwayLoading}>
              {runway ? "Recompute" : "Compute"}
            </Button>
          </Group>
          {runwayError && <Text size="xs" c="red">{runwayError}</Text>}
          {!runway && !runwayError && (
            <Text size="xs" c="dimmed">
              On-demand: walks upcoming schedule fires + reserved order spends against
              current balances (real buckets read on-chain).
            </Text>
          )}
          {runway && runway.buckets.length === 0 && (
            <Text size="xs" c="dimmed">no computable spend — nothing to forecast</Text>
          )}
          {runway && runway.buckets.length > 0 && (
            <Stack gap={4}>
              {runway.buckets.slice(0, 8).map((b, i) => {
                const sym = b.symbol ?? (b.token === "native" ? "native" : `${b.token.slice(0, 8)}…`);
                const verdict =
                  b.balance == null ? { color: "gray", text: "balance unknown" } :
                  b.exhaustsAt != null && (b.runwayDays ?? 0) <= 7 ? { color: "red", text: `runs out ${b.exhaustsAt.slice(0, 10)} (${b.runwayDays!.toFixed(1)}d)` } :
                  b.exhaustsAt != null ? { color: "yellow", text: `runs out ${b.exhaustsAt.slice(0, 10)} (${b.runwayDays!.toFixed(1)}d)` } :
                  { color: "teal", text: `survives ${runway.horizonDays}d` };
                return (
                  <Group key={i} gap={6} wrap="nowrap">
                    <Badge size="xs" color={verdict.color} variant="filled" style={{ flexShrink: 0 }}>
                      {sym}
                    </Badge>
                    <Text size="xs" ff="monospace" style={{ flex: 1 }}>
                      {b.account}/{b.chain}{b.paper ? " [paper]" : ""} · bal {b.balance == null ? "?" : b.balance.toFixed(2)} · {verdict.text}
                      {b.exhaustsAt != null ? ` · ${b.firesCovered}/${b.totalFiresInHorizon} fires` : ""}
                    </Text>
                  </Group>
                );
              })}
              {runway.skipped.length > 0 && (
                <Text size="xs" c="dimmed">({runway.skipped.length} primitive(s) skipped — spend needs a price)</Text>
              )}
            </Stack>
          )}
        </Card>
      </Group>
    </Stack>
  );
}
