// Timeline page — the forensic event stream in the browser.
//
// One chronological view across every subsystem: trades (real +
// paper), engine decision journals (orders / schedules / rebalance,
// incl. v32 retry_scheduled + v33 recovered), audit entries, alert
// transitions + circuit-breaker trips, and engine lifecycle events.
// Mirrors `tradekit timeline` (the /api/timeline route shares the
// same collector); filters map 1:1 to the CLI flags.
//
// Read-only; auto-refreshes every 30s when the page is visible.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Code,
  Collapse,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { getTimeline, type PageProps, type TimelineEventRow, type TimelineSeverity } from "../api";

const REFRESH_MS = 30_000;

// Kind groups: the raw kind list is 21 entries — too granular for a
// filter UI. Groups mirror how operators think ("show me trades and
// alerts"); the group → kinds expansion happens client-side so the
// API contract stays kind-level.
const KIND_GROUPS: Record<string, string[]> = {
  trades: ["trade.fill", "trade.failure", "trade.pending", "paper.fill"],
  orders: ["order.journal", "order.edited"],
  schedules: ["schedule.journal"],
  rebalance: ["rebalance.journal"],
  alerts: ["alert.fired", "alert.resolved", "alert.breaker"],
  audit: ["audit.tool", "audit.error"],
  engine: [
    "engine.started", "engine.stopped", "engine.lock", "engine.unlock",
    "worker.degraded", "worker.recovered", "config.reloaded", "config.reload_failed",
  ],
};
const GROUP_NAMES = Object.keys(KIND_GROUPS);

const WINDOWS = [
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
];

function severityColor(s: TimelineSeverity): string {
  if (s === "critical") return "red";
  if (s === "warn") return "yellow";
  return "blue";
}

function kindColor(kind: string): string {
  if (kind.startsWith("trade") || kind === "paper.fill") return "teal";
  if (kind.startsWith("order")) return "blue";
  if (kind.startsWith("schedule")) return "grape";
  if (kind.startsWith("rebalance")) return "violet";
  if (kind.startsWith("alert")) return "orange";
  if (kind.startsWith("audit")) return "gray";
  return "cyan"; // engine / worker / config
}

function timeOf(iso: string): string {
  return iso.slice(11, 19);
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function EventRow({ ev }: { ev: TimelineEventRow }) {
  const [open, setOpen] = useState(false);
  const hasDetails = ev.details != null && Object.keys(ev.details).length > 0;
  return (
    <div style={{ borderBottom: "1px solid var(--mantine-color-dark-6)", padding: "6px 4px" }}>
      <UnstyledButton onClick={() => hasDetails && setOpen((o) => !o)} style={{ width: "100%", cursor: hasDetails ? "pointer" : "default" }}>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Tooltip label={ev.at} withArrow>
            <Text size="xs" c="dimmed" ff="monospace" w={62} style={{ flexShrink: 0 }}>
              {timeOf(ev.at)}
            </Text>
          </Tooltip>
          <Badge size="xs" color={severityColor(ev.severity)} variant={ev.severity === "info" ? "light" : "filled"} w={24} px={4} style={{ flexShrink: 0 }}>
            {ev.severity === "critical" ? "C" : ev.severity === "warn" ? "W" : "i"}
          </Badge>
          <Badge size="xs" color={kindColor(ev.kind)} variant="light" style={{ flexShrink: 0 }}>
            {ev.kind}
          </Badge>
          <Text size="xs" ff="monospace" style={{ wordBreak: "break-word", flex: 1 }}>
            {ev.summary}
          </Text>
          {ev.refs.strategy && (
            <Badge size="xs" variant="outline" color="gray" style={{ flexShrink: 0 }}>
              {ev.refs.strategy}
            </Badge>
          )}
        </Group>
      </UnstyledButton>
      {hasDetails && (
        <Collapse in={open}>
          <Code block mt={4} style={{ fontSize: 11 }}>
            {Object.entries(ev.details!)
              .filter(([, v]) => v != null && v !== "")
              .map(([k, v]) => `${k}: ${String(v)}`)
              .join("\n")}
          </Code>
        </Collapse>
      )}
    </div>
  );
}

export function Timeline(_props: PageProps) {
  const [windowSel, setWindowSel] = useState("24h");
  const [minSeverity, setMinSeverity] = useState<string>("info");
  const [groups, setGroups] = useState<string[]>(GROUP_NAMES); // all on
  const [strategy, setStrategy] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [events, setEvents] = useState<TimelineEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const kinds = useMemo(() => {
    if (groups.length === GROUP_NAMES.length) return undefined; // all → omit param
    return groups.flatMap((g) => KIND_GROUPS[g] ?? []);
  }, [groups]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await getTimeline({
        since: windowSel,
        kinds,
        minSeverity: minSeverity === "info" ? undefined : (minSeverity as TimelineSeverity),
        strategy: strategy.trim() || undefined,
        limit: 300,
      });
      setEvents(resp.events);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [windowSel, kinds, minSeverity, strategy]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, refresh]);

  // Group by day for date dividers. Events arrive newest-first.
  const byDay = useMemo(() => {
    const out: Array<{ day: string; rows: TimelineEventRow[] }> = [];
    for (const ev of events ?? []) {
      const day = dayOf(ev.at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(ev);
      else out.push({ day, rows: [ev] });
    }
    return out;
  }, [events]);

  const toggleGroup = (g: string) =>
    setGroups((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <Title order={4}>Timeline</Title>
        <Group gap="xs">
          <Switch size="xs" label="auto-refresh" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.currentTarget.checked)} />
          <Button size="compact-xs" variant="default" onClick={refresh} loading={loading}>
            Refresh
          </Button>
        </Group>
      </Group>

      <Card withBorder padding="sm">
        <Group gap="md" wrap="wrap" align="flex-end">
          <div>
            <Text size="xs" c="dimmed" mb={4}>Window</Text>
            <SegmentedControl size="xs" data={WINDOWS} value={windowSel} onChange={setWindowSel} />
          </div>
          <div>
            <Text size="xs" c="dimmed" mb={4}>Min severity</Text>
            <SegmentedControl
              size="xs"
              data={[
                { label: "all", value: "info" },
                { label: "warn+", value: "warn" },
                { label: "critical", value: "critical" },
              ]}
              value={minSeverity}
              onChange={setMinSeverity}
            />
          </div>
          <TextInput
            size="xs"
            label={<Text size="xs" c="dimmed">Strategy tag</Text>}
            placeholder="playbook:7"
            value={strategy}
            onChange={(e) => setStrategy(e.currentTarget.value)}
            w={140}
          />
        </Group>
        <Group gap={6} mt="sm" wrap="wrap">
          {GROUP_NAMES.map((g) => (
            <Badge
              key={g}
              size="sm"
              variant={groups.includes(g) ? "filled" : "outline"}
              color={groups.includes(g) ? "blue" : "gray"}
              style={{ cursor: "pointer", textTransform: "none" }}
              onClick={() => toggleGroup(g)}
            >
              {g}
            </Badge>
          ))}
        </Group>
      </Card>

      {error && <Text c="red" size="sm">Failed to load: {error}</Text>}
      {events == null && !error && (
        <Group justify="center" p="xl"><Loader size="sm" /></Group>
      )}
      {events != null && events.length === 0 && (
        <Text c="dimmed" size="sm" ta="center" p="xl">
          No events in this window match the filters.
        </Text>
      )}

      {byDay.map(({ day, rows }) => (
        <Card key={day} withBorder padding="xs">
          <Text size="xs" fw={700} c="dimmed" mb={4}>
            {day} · {rows.length} event{rows.length === 1 ? "" : "s"}
          </Text>
          {rows.map((ev, i) => (
            <EventRow key={`${ev.at}-${ev.kind}-${i}`} ev={ev} />
          ))}
        </Card>
      ))}
    </Stack>
  );
}
