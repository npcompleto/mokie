import {
  ActionIcon,
  Button,
  Code,
  Drawer,
  Group,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconSearch, IconTrash, IconWand, IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import type { TrafficEntry, TrafficSummary } from '@mokie/shared';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { attempt, navigate, setPendingDraft, useEvent } from '../hooks.ts';
import { CodeEditor, fmtTime, MethodBadge, prettyBody, SourceBadge, StatusText } from '../components/common.tsx';

const MAX_ROWS = 500;

export function TrafficPage() {
  const [rows, setRows] = useState<TrafficSummary[]>([]);
  const [q, setQ] = useState('');
  const [source, setSource] = useState('all');
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<TrafficEntry | null>(null);

  const load = () => attempt(() => api.traffic({ q, source: source === 'all' ? undefined : source, limit: 200 })).then((r) => r && setRows(r));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, source]);

  useEvent('traffic', (t: TrafficSummary) => {
    if (!live) return;
    if (source !== 'all' && t.source !== source) return;
    if (q && !`${t.method} ${t.url}`.toLowerCase().includes(q.toLowerCase())) return;
    setRows((r) => [t, ...r].slice(0, MAX_ROWS));
  });

  const open = async (id: number) => {
    const e = await attempt(() => api.trafficEntry(id));
    if (e) setSelected(e);
  };

  const toMock = async (id: number) => {
    const draft = await attempt(() => api.trafficToMock(id));
    if (!draft) return;
    setPendingDraft(draft);
    navigate('mocks/new');
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Traffico</Title>
        <Group gap="xs">
          <TextInput
            placeholder="Filtra per URL o metodo"
            leftSection={<IconSearch size={14} />}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            w={260}
            size="xs"
          />
          <SegmentedControl
            size="xs"
            value={source}
            onChange={setSource}
            data={[
              { value: 'all', label: 'Tutto' },
              { value: 'mock', label: 'Mock' },
              { value: 'proxy', label: 'Proxy' },
              { value: 'flow', label: 'Flussi' },
              { value: 'error', label: 'Errori' },
            ]}
          />
          <Tooltip label={live ? 'Metti in pausa gli aggiornamenti live' : 'Riprendi aggiornamenti live'}>
            <ActionIcon variant={live ? 'light' : 'default'} onClick={() => (live ? setLive(false) : (setLive(true), load()))}>
              {live ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Svuota il log">
            <ActionIcon variant="default" color="red" onClick={() => attempt(api.clearTraffic).then(() => setRows([]))}>
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {rows.length === 0 ? (
        <Text c="dimmed" ta="center" py="xl">
          Nessuna richiesta ancora. Configura un backend e punta i tuoi client alla porta proxy di Mokie.
        </Text>
      ) : (
        <Table highlightOnHover striped="even" verticalSpacing={4} fz="sm" stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={110}>Ora</Table.Th>
              <Table.Th w={90}>Metodo</Table.Th>
              <Table.Th>URL</Table.Th>
              <Table.Th w={70}>Status</Table.Th>
              <Table.Th w={100}>Sorgente</Table.Th>
              <Table.Th w={80} ta="right">
                Durata
              </Table.Th>
              <Table.Th w={50} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => open(r.id)}>
                <Table.Td ff="monospace" c="dimmed">
                  {fmtTime(r.ts)}
                </Table.Td>
                <Table.Td>
                  <MethodBadge method={r.method} />
                </Table.Td>
                <Table.Td ff="monospace" style={{ wordBreak: 'break-all' }}>
                  {r.url}
                  {r.note && (
                    <Text span c="dimmed" size="xs" ml={8}>
                      {r.note}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <StatusText status={r.status} />
                </Table.Td>
                <Table.Td>
                  <SourceBadge source={r.source} />
                </Table.Td>
                <Table.Td ta="right" ff="monospace" c="dimmed">
                  {r.durationMs} ms
                </Table.Td>
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  {r.source !== 'flow' && (
                    <Tooltip label="Crea mock da questa richiesta">
                      <ActionIcon variant="subtle" onClick={() => toMock(r.id)}>
                        <IconWand size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Drawer
        opened={!!selected}
        onClose={() => setSelected(null)}
        position="right"
        size="xl"
        title={
          selected && (
            <Group gap="xs">
              <MethodBadge method={selected.method} />
              <Text ff="monospace" size="sm" style={{ wordBreak: 'break-all' }}>
                {selected.url}
              </Text>
            </Group>
          )
        }
      >
        {selected && <TrafficDetail entry={selected} onToMock={() => toMock(selected.id)} />}
      </Drawer>
    </Stack>
  );
}

function Headers({ h }: { h: Record<string, string> }) {
  return (
    <Table fz="xs" verticalSpacing={2}>
      <Table.Tbody>
        {Object.entries(h).map(([k, v]) => (
          <Table.Tr key={k}>
            <Table.Td fw={600} w={200} style={{ verticalAlign: 'top' }}>
              {k}
            </Table.Td>
            <Table.Td ff="monospace" style={{ wordBreak: 'break-all' }}>
              {v}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function TrafficDetail({ entry, onToMock }: { entry: TrafficEntry; onToMock: () => void }) {
  const [raw, setRaw] = useState(false);
  const curl = [
    `curl -X ${entry.method} '${location.protocol}//${entry.reqHeaders.host ?? 'localhost'}${entry.url}'`,
    ...Object.entries(entry.reqHeaders)
      .filter(([k]) => !['host', 'content-length', 'connection'].includes(k))
      .map(([k, v]) => `  -H '${k}: ${v.replace(/'/g, "'\\''")}'`),
    ...(entry.reqBody ? [`  --data-raw '${entry.reqBody.replace(/'/g, "'\\''")}'`] : []),
  ].join(' \\\n');
  return (
    <Stack>
      <Group justify="space-between">
        <Group gap="md">
          <StatusText status={entry.status} />
          <SourceBadge source={entry.source} />
          <Text size="sm" c="dimmed">
            {entry.durationMs} ms · {new Date(entry.ts).toLocaleString('it-IT')}
          </Text>
          {entry.mockId && (
            <Button size="compact-xs" variant="subtle" onClick={() => navigate(`mocks/${entry.mockId}`)}>
              apri mock #{entry.mockId}
            </Button>
          )}
        </Group>
        <Group gap="xs">
          <Switch size="xs" label="raw" checked={raw} onChange={(e) => setRaw(e.currentTarget.checked)} />
          {entry.source !== 'flow' && (
            <Button size="xs" leftSection={<IconWand size={14} />} onClick={onToMock}>
              Crea mock
            </Button>
          )}
        </Group>
      </Group>
      {entry.note && <Code>{entry.note}</Code>}
      <Tabs defaultValue="response" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="request">Richiesta</Tabs.Tab>
          <Tabs.Tab value="response">Risposta</Tabs.Tab>
          <Tabs.Tab value="curl">cURL</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="request" pt="sm">
          <Stack>
            <Headers h={entry.reqHeaders} />
            {entry.reqBody && (
              <CodeEditor readOnly lang={raw ? 'text' : 'json'} height="auto" value={raw ? entry.reqBody : prettyBody(entry.reqBody, entry.reqHeaders['content-type'])} />
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="response" pt="sm">
          <Stack>
            <Headers h={entry.resHeaders} />
            <ScrollArea.Autosize mah="60vh">
              <CodeEditor readOnly lang={raw ? 'text' : 'json'} height="auto" value={raw ? entry.resBody : prettyBody(entry.resBody, entry.resHeaders['content-type'])} />
            </ScrollArea.Autosize>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="curl" pt="sm">
          <Code block>{curl}</Code>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
