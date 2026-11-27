import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Grid,
  Group,
  Menu,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconCheck,
  IconCopy,
  IconDots,
  IconFolderPlus,
  IconPencil,
  IconPlus,
  IconTrash,
  IconX,
  IconBulb,
  IconPlayerPlay,
  IconSend,
} from '@tabler/icons-react';
import { HTTP_METHODS, type Collection, type Condition, type Mock, type MockInput, type TrafficSource } from '@mokie/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, type CallResult, type Explain } from '../api/client.ts';
import { attempt, navigate, takePendingDraft, useEvent, useLoad } from '../hooks.ts';
import { CodeEditor, ConditionsEditor, EffectsEditor, KeyValueEditor, MethodBadge, prettyBody, SourceBadge, StatusText } from '../components/common.tsx';

const EMPTY: MockInput = {
  collectionId: null,
  name: 'Nuovo mock',
  enabled: true,
  priority: 0,
  method: 'GET',
  pathPattern: '/',
  conditionMode: 'all',
  conditions: [],
  response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{\n  "ok": true\n}', delayMs: 0 },
  effects: [],
  script: '',
  createdFromTrafficId: null,
};

const strip = (m: Mock): MockInput => {
  const { id, createdAt, updatedAt, ...rest } = m;
  return rest;
};

export function MocksPage({ id }: { id?: string }) {
  const mocks = useLoad(api.mocks);
  const cols = useLoad(api.collections);
  useEvent('config', (what: string) => {
    if (what === 'mocks' || what === 'import') mocks.reload();
    if (what === 'collections' || what === 'import') cols.reload();
  });
  const [colModal, setColModal] = useState<Partial<Collection> | null>(null);

  const groups = useMemo(() => {
    const list = mocks.data ?? [];
    const out: { col: Collection | null; mocks: Mock[] }[] = [];
    for (const c of cols.data ?? []) out.push({ col: c, mocks: list.filter((m) => m.collectionId === c.id) });
    const loose = list.filter((m) => m.collectionId === null || !(cols.data ?? []).some((c) => c.id === m.collectionId));
    if (loose.length || !out.length) out.push({ col: null, mocks: loose });
    return out;
  }, [mocks.data, cols.data]);

  const saveCollection = async () => {
    if (!colModal) return;
    const input = { name: colModal.name ?? '', description: colModal.description ?? '', enabled: colModal.enabled ?? true };
    const r = await attempt(() => (colModal.id ? api.updateCollection(colModal.id, input) : api.createCollection(input)), 'Collection salvata');
    if (r) {
      setColModal(null);
      cols.reload();
    }
  };

  return (
    <Grid gutter="md">
      <Grid.Col span={{ base: 12, md: 4 }}>
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={3}>Mock</Title>
            <Group gap={4}>
              <Tooltip label="Nuova collection">
                <ActionIcon variant="default" onClick={() => setColModal({ enabled: true })}>
                  <IconFolderPlus size={16} />
                </ActionIcon>
              </Tooltip>
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => navigate('mocks/new')}>
                Nuovo
              </Button>
            </Group>
          </Group>
          <Text size="xs" c="dimmed">
            I mock sono valutati in ordine di priorità (più alta prima). Vince il primo che soddisfa metodo, path e condizioni;
            altrimenti la richiesta va al backend.
          </Text>
          {groups.map(({ col, mocks: list }) => (
            <Paper key={col?.id ?? 'none'} withBorder p="xs" opacity={col && !col.enabled ? 0.55 : 1}>
              <Group justify="space-between" mb={4}>
                <Group gap={6}>
                  <Text fw={600} size="sm">
                    {col?.name ?? 'Senza collection'}
                  </Text>
                  <Badge size="xs" variant="light" color="gray">
                    {list.length}
                  </Badge>
                </Group>
                {col && (
                  <Group gap={4}>
                    <Tooltip label={col.enabled ? 'Disattiva scenario' : 'Attiva scenario'}>
                      <Switch
                        size="xs"
                        checked={col.enabled}
                        onChange={(e) =>
                          attempt(() => api.updateCollection(col.id, { ...col, enabled: e.currentTarget.checked })).then(() => cols.reload())
                        }
                      />
                    </Tooltip>
                    <Menu position="bottom-end">
                      <Menu.Target>
                        <ActionIcon size="sm" variant="subtle">
                          <IconDots size={14} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setColModal(col)}>
                          Rinomina
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          onClick={() =>
                            confirm(`Eliminare la collection "${col.name}"? I mock resteranno senza collection.`) &&
                            attempt(() => api.deleteCollection(col.id)).then(() => (cols.reload(), mocks.reload()))
                          }
                        >
                          Elimina
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                )}
              </Group>
              {col?.description && (
                <Text size="xs" c="dimmed" mb={4}>
                  {col.description}
                </Text>
              )}
              <Stack gap={2}>
                {list.map((m) => (
                  <UnstyledButton
                    key={m.id}
                    onClick={() => navigate(`mocks/${m.id}`)}
                    p={6}
                    style={{
                      borderRadius: 6,
                      background: String(m.id) === id ? 'var(--mantine-color-violet-light)' : undefined,
                    }}
                  >
                    <Group gap={8} wrap="nowrap">
                      <Switch
                        size="xs"
                        checked={m.enabled}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => attempt(() => api.setMockEnabled(m.id, e.currentTarget.checked)).then(() => mocks.reload())}
                      />
                      <MethodBadge method={m.method} />
                      <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                        <Text size="sm" truncate>
                          {m.name}
                        </Text>
                        <Text size="xs" c="dimmed" ff="monospace" truncate>
                          {m.pathPattern}
                          {m.conditions.length > 0 && ` · ${m.conditions.length} cond.`}
                          {m.script.trim() && ' · script'}
                        </Text>
                      </Stack>
                      {m.priority !== 0 && (
                        <Badge size="xs" variant="outline" color="gray">
                          p{m.priority}
                        </Badge>
                      )}
                    </Group>
                  </UnstyledButton>
                ))}
                {list.length === 0 && (
                  <Text size="xs" c="dimmed" p={6}>
                    vuota
                  </Text>
                )}
              </Stack>
            </Paper>
          ))}
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 8 }}>
        {id ? (
          <MockEditor
            key={id}
            id={id}
            collections={cols.data ?? []}
            onSaved={(m) => {
              mocks.reload();
              if (String(m.id) !== id) navigate(`mocks/${m.id}`);
            }}
            onDeleted={() => {
              mocks.reload();
              navigate('mocks');
            }}
          />
        ) : (
          <Card withBorder p="xl">
            <Stack align="center" gap="xs">
              <Text c="dimmed">Seleziona un mock o creane uno nuovo.</Text>
              <Text c="dimmed" size="sm">
                Suggerimento: dalla pagina Traffico puoi trasformare una richiesta reale in un mock.
              </Text>
            </Stack>
          </Card>
        )}
      </Grid.Col>

      <Modal opened={!!colModal} onClose={() => setColModal(null)} title={colModal?.id ? 'Modifica collection' : 'Nuova collection'}>
        <Stack>
          <TextInput label="Nome" value={colModal?.name ?? ''} onChange={(e) => setColModal({ ...colModal, name: e.currentTarget.value })} data-autofocus />
          <Textarea
            label="Descrizione"
            value={colModal?.description ?? ''}
            onChange={(e) => setColModal({ ...colModal, description: e.currentTarget.value })}
          />
          <Group justify="flex-end">
            <Button onClick={saveCollection}>Salva</Button>
          </Group>
        </Stack>
      </Modal>
    </Grid>
  );
}

function MockEditor({
  id,
  collections,
  onSaved,
  onDeleted,
}: {
  id: string;
  collections: Collection[];
  onSaved: (m: Mock) => void;
  onDeleted: () => void;
}) {
  const isNew = id === 'new';
  const [form, setForm] = useState<MockInput | null>(null);
  const [suggested, setSuggested] = useState<Condition[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (isNew) {
      const draft = takePendingDraft<{ mock: MockInput; suggestedConditions: Condition[] }>();
      setForm(draft?.mock ?? EMPTY);
      setSuggested(draft?.suggestedConditions ?? []);
      setDirty(!!draft);
    } else {
      attempt(() => api.mock(Number(id))).then((m) => m && setForm(strip(m)));
    }
  }, [id, isNew]);

  if (!form) return null;
  const set = (patch: Partial<MockInput>) => {
    setForm({ ...form, ...patch });
    setDirty(true);
  };
  const setRes = (patch: Partial<MockInput['response']>) => set({ response: { ...form.response, ...patch } });

  const save = async () => {
    const r = await attempt(() => (isNew ? api.createMock(form) : api.updateMock(Number(id), form)), 'Mock salvato');
    if (r) {
      setDirty(false);
      onSaved(r);
    }
  };

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between" align="flex-end">
          <TextInput label="Nome" value={form.name} onChange={(e) => set({ name: e.currentTarget.value })} style={{ flex: 1 }} />
          <Select
            label="Collection"
            w={200}
            clearable
            placeholder="nessuna"
            data={collections.map((c) => ({ value: String(c.id), label: c.name }))}
            value={form.collectionId != null ? String(form.collectionId) : null}
            onChange={(v) => set({ collectionId: v ? Number(v) : null })}
          />
          <NumberInput label="Priorità" w={90} value={form.priority} onChange={(v) => set({ priority: Number(v) || 0 })} />
          <Switch label="Attivo" checked={form.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} mb={8} />
        </Group>
        <Group gap="xs" align="flex-end">
          <Select
            label="Metodo"
            w={120}
            data={HTTP_METHODS as unknown as string[]}
            value={form.method}
            onChange={(v) => set({ method: (v ?? 'GET') as MockInput['method'] })}
            allowDeselect={false}
          />
          <TextInput
            label="Path"
            description="/orders/:id · /files/* · ^regex$"
            className="mono"
            style={{ flex: 1 }}
            value={form.pathPattern}
            onChange={(e) => set({ pathPattern: e.currentTarget.value })}
          />
        </Group>

        <Tabs defaultValue="match" keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="match">
              Condizioni {form.conditions.length > 0 && <Badge size="xs" ml={4}>{form.conditions.length}</Badge>}
            </Tabs.Tab>
            <Tabs.Tab value="response">Risposta</Tabs.Tab>
            <Tabs.Tab value="effects">
              Effetti sullo stato {form.effects.length > 0 && <Badge size="xs" ml={4}>{form.effects.length}</Badge>}
            </Tabs.Tab>
            <Tabs.Tab value="script">Script {form.script.trim() && <Badge size="xs" ml={4}>on</Badge>}</Tabs.Tab>
            <Tabs.Tab value="test" leftSection={<IconPlayerPlay size={14} />}>
              Prova
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="match" pt="md">
            <Stack>
              <Group gap="xs">
                <Text size="sm">Attiva il mock quando</Text>
                <SegmentedControl
                  size="xs"
                  value={form.conditionMode}
                  onChange={(v) => set({ conditionMode: v as 'all' | 'any' })}
                  data={[
                    { value: 'all', label: 'tutte (AND)' },
                    { value: 'any', label: 'almeno una (OR)' },
                  ]}
                />
                <Text size="sm">le condizioni sono vere.</Text>
              </Group>
              <ConditionsEditor value={form.conditions} onChange={(conditions) => set({ conditions })} />
              {suggested.length > 0 && (
                <Alert variant="light" icon={<IconBulb size={16} />} title="Condizioni suggerite dalla richiesta originale">
                  <Group gap={6}>
                    {suggested.map((c, i) => (
                      <Button
                        key={i}
                        size="compact-xs"
                        variant="default"
                        leftSection={<IconPlus size={12} />}
                        onClick={() => {
                          set({ conditions: [...form.conditions, c] });
                          setSuggested(suggested.filter((_, j) => j !== i));
                        }}
                      >
                        <Text span size="xs" ff="monospace">
                          {c.source}:{c.key} = {c.value.length > 30 ? c.value.slice(0, 30) + '…' : c.value}
                        </Text>
                      </Button>
                    ))}
                  </Group>
                </Alert>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="response" pt="md">
            <Stack>
              <Group align="flex-end">
                <NumberInput label="Status" w={100} min={100} max={599} value={form.response.status} onChange={(v) => setRes({ status: Number(v) || 200 })} />
                <NumberInput
                  label="Ritardo (ms)"
                  w={130}
                  min={0}
                  step={100}
                  value={form.response.delayMs}
                  onChange={(v) => setRes({ delayMs: Number(v) || 0 })}
                />
              </Group>
              <div>
                <Text size="sm" fw={500} mb={4}>
                  Header
                </Text>
                <KeyValueEditor value={form.response.headers} onChange={(headers) => setRes({ headers })} />
              </div>
              <div>
                <Text size="sm" fw={500} mb={4}>
                  Body (template Handlebars)
                </Text>
                <CodeEditor value={form.response.body} onChange={(body) => setRes({ body })} height="320px" lang="text" />
                <TemplateHelp />
              </div>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="effects" pt="md">
            <Stack>
              <Text size="sm" c="dimmed">
                Modifiche applicate allo stato condiviso quando il mock risponde (prima di generare la risposta, che vede quindi lo
                stato aggiornato). Percorsi e valori accettano template, es. <Code>orders.{'{{params.id}}'}</Code>.
              </Text>
              <EffectsEditor value={form.effects} onChange={(effects) => set({ effects })} />
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="script" pt="md">
            <Stack>
              <Text size="sm" c="dimmed">
                Script JavaScript opzionale (supporta <Code>await</Code>). Se restituisce un oggetto <Code>{'{ status, headers, body }'}</Code>{' '}
                quello è la risposta; se non restituisce nulla si usa la risposta della tab "Risposta".
              </Text>
              <CodeEditor
                value={form.script}
                onChange={(script) => set({ script })}
                lang="js"
                height="300px"
                placeholder={SCRIPT_PLACEHOLDER}
              />
              <Code block fz="xs">
                {SCRIPT_HELP}
              </Code>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="test" pt="md">
            <MockTester mockId={isNew ? null : Number(id)} form={form} dirty={dirty} />
          </Tabs.Panel>
        </Tabs>

        <Group justify="space-between">
          <Group gap="xs">
            {!isNew && (
              <>
                <Button
                  variant="subtle"
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => confirm('Eliminare questo mock?') && attempt(() => api.deleteMock(Number(id))).then(onDeleted)}
                >
                  Elimina
                </Button>
                <Button
                  variant="subtle"
                  leftSection={<IconCopy size={14} />}
                  onClick={() => attempt(() => api.duplicateMock(Number(id)), 'Mock duplicato').then((m) => m && onSaved(m))}
                >
                  Duplica
                </Button>
              </>
            )}
            {form.createdFromTrafficId && (
              <Text size="xs" c="dimmed">
                creato dalla richiesta #{form.createdFromTrafficId}
              </Text>
            )}
          </Group>
          <Button onClick={save} disabled={!dirty && !isNew}>
            {isNew ? 'Crea mock' : 'Salva'}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function TemplateHelp() {
  return (
    <Text size="xs" c="dimmed" mt={6} style={{ lineHeight: 1.7 }}>
      Variabili: <Code>{'{{params.id}}'}</Code> <Code>{'{{query.x}}'}</Code> <Code>{'{{headers.authorization}}'}</Code>{' '}
      <Code>{'{{body.user.name}}'}</Code> <Code>{'{{state.cart.total}}'}</Code> <Code>{'{{vars.x}}'}</Code> · Helper:{' '}
      <Code>{'{{json state.cart}}'}</Code> <Code>{"{{get state (concat 'orders.' params.id)}}"}</Code> <Code>{"{{id 'order'}}"}</Code>{' '}
      <Code>{'{{uuid}}'}</Code> <Code>{"{{now 'iso'}}"}</Code> <Code>{'{{randomInt 1 100}}'}</Code> <Code>{'{{default x 0}}'}</Code>{' '}
      <Code>{'{{#if (eq a b)}}…{{/if}}'}</Code> <Code>{'{{#each state.items}}…{{/each}}'}</Code>{' '}
      <Code>{"{{flowUrl 'payment' redirectUrl=body.redirect_url orderId=body.orderId}}"}</Code>
    </Text>
  );
}

const SCRIPT_PLACEHOLDER = `// esempio: risposta diversa al terzo tentativo
const n = state.incr('attempts.' + params.id);
if (n >= 3) return respond(200, { id: params.id, status: 'OK' });
return respond(503, { error: 'retry later', attempt: n });`;

const SCRIPT_HELP = `req, params, query, headers, cookies, body, vars     dati della richiesta (vars: passati al template)
state.get(p) .set(p,v) .merge(p,v) .incr(p,n) .push(p,v) .remove(p) .all()
respond(status, body, headers?)  |  return { status, headers, body }
await forward({ method?, path?, headers?, body? })  → { status, headers, body }  (risposta del backend, modificabile)
pass()                         rinuncia al mock: la richiesta va al backend
flow.url(slug, ctx)            crea una sessione di pagina interattiva e ne ritorna l'URL
template(str)  uuid()  await sleep(ms)  console.log(...)`;

function MockTester({ mockId, form, dirty }: { mockId: number | null; form: MockInput; dirty: boolean }) {
  const samplePath = form.pathPattern.startsWith('^') ? '/' : form.pathPattern.replace(/:(\w+)\??/g, '1').replace(/\*/g, 'x');
  const [req, setReq] = useState({
    method: (form.method === 'ANY' ? 'GET' : form.method) as string,
    url: samplePath,
    headers: '{\n  "content-type": "application/json"\n}',
    body: '',
  });
  const [res, setRes] = useState<Explain | null>(null);
  const [callRes, setCallRes] = useState<CallResult | null>(null);
  const [calling, setCalling] = useState(false);

  const parseHeaders = (): Record<string, string> | null => {
    try {
      return req.headers.trim() ? JSON.parse(req.headers) : {};
    } catch {
      attempt(() => Promise.reject(new Error('Header: JSON non valido')));
      return null;
    }
  };
  const run = async () => {
    const headers = parseHeaders();
    if (!headers) return;
    const r = await attempt(() => api.explain({ ...req, headers }));
    if (r) {
      setRes(r);
      setCallRes(null);
    }
  };
  const callIt = async () => {
    const headers = parseHeaders();
    if (!headers) return;
    setCalling(true);
    const r = await attempt(() => api.callEndpoint({ ...req, headers }));
    setCalling(false);
    if (r) {
      setCallRes(r);
      setRes(null);
    }
  };
  const mine = res?.evaluations.find((e) => e.mockId === mockId);
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        <b>Valuta</b> mostra quale mock risponderebbe e perché, senza effetti. <b>Chiama</b> invia davvero la richiesta come
        un client sulla porta proxy: applica gli effetti sullo stato, può raggiungere il backend e compare nel Traffico.
        {dirty && ' Le modifiche non salvate non sono considerate: salva prima di provarle.'}
      </Text>
      <Group gap="xs" align="flex-end">
        <Select
          w={110}
          label="Metodo"
          data={HTTP_METHODS.filter((m) => m !== 'ANY') as unknown as string[]}
          value={req.method}
          onChange={(v) => setReq({ ...req, method: v ?? 'GET' })}
          allowDeselect={false}
        />
        <TextInput label="URL" style={{ flex: 1 }} className="mono" value={req.url} onChange={(e) => setReq({ ...req, url: e.currentTarget.value })} />
        <Button variant="default" onClick={run} leftSection={<IconPlayerPlay size={14} />}>
          Valuta
        </Button>
        <Button onClick={callIt} loading={calling} leftSection={<IconSend size={14} />}>
          Chiama
        </Button>
      </Group>
      <Grid>
        <Grid.Col span={6}>
          <Text size="sm" fw={500} mb={4}>
            Header (JSON)
          </Text>
          <CodeEditor value={req.headers} onChange={(headers) => setReq({ ...req, headers })} height="120px" />
        </Grid.Col>
        <Grid.Col span={6}>
          <Text size="sm" fw={500} mb={4}>
            Body
          </Text>
          <CodeEditor value={req.body} onChange={(body) => setReq({ ...req, body })} height="120px" />
        </Grid.Col>
      </Grid>
      {callRes && (
        <Stack gap="xs">
          <Group gap="md">
            <StatusText status={callRes.status} />
            <SourceBadge source={callRes.source as TrafficSource} />
            <Text size="sm" c="dimmed">
              {callRes.durationMs} ms
              {callRes.source === 'mock' && callRes.mockId != null && (callRes.mockId === mockId ? ' · ha risposto questo mock' : ` · ha risposto il mock #${callRes.mockId}`)}
              {callRes.note && callRes.source !== 'mock' && ` · ${callRes.note}`}
            </Text>
          </Group>
          <Table fz="xs" verticalSpacing={2}>
            <Table.Tbody>
              {Object.entries(callRes.headers).map(([k, v]) => (
                <Table.Tr key={k}>
                  <Table.Td fw={600} w={180}>
                    {k}
                  </Table.Td>
                  <Table.Td ff="monospace" style={{ wordBreak: 'break-all' }}>
                    {v}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <CodeEditor readOnly height="auto" value={prettyBody(callRes.body, callRes.headers['content-type']) || '(body vuoto)'} />
        </Stack>
      )}
      {res && (
        <Stack gap="xs">
          <Alert color={res.winner ? (res.winner.id === mockId ? 'teal' : 'yellow') : 'blue'} variant="light">
            {res.winner ? (
              <>
                Risponderebbe il mock <b>{res.winner.name}</b> (#{res.winner.id})
                {res.winner.id === mockId ? ' — questo.' : '.'}
              </>
            ) : res.backend ? (
              <>
                Nessun mock: la richiesta andrebbe al backend <b>{res.backend.name}</b> ({res.backend.baseUrl}).
              </>
            ) : (
              <>Nessun mock e nessun backend: risposta di fallback.</>
            )}
          </Alert>
          {mine && (
            <Table fz="xs">
              <Table.Tbody>
                <Row ok={mine.methodOk} label="metodo" />
                <Row ok={mine.pathOk} label={`path ${Object.keys(mine.params).length ? JSON.stringify(mine.params) : ''}`} />
                {mine.conditions.map((c, i) => (
                  <Row
                    key={i}
                    ok={c.passed}
                    label={`${c.condition.source} ${c.condition.key} ${c.condition.operator} ${c.condition.value}`}
                    extra={c.error ? `errore: ${c.error}` : `valore: ${JSON.stringify(c.actual) ?? 'undefined'}`}
                  />
                ))}
                {!mine.active && <Row ok={false} label="mock (o la sua collection) disattivato" />}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      )}
    </Stack>
  );
}

const Row = ({ ok, label, extra }: { ok: boolean; label: string; extra?: string }) => (
  <Table.Tr>
    <Table.Td w={24}>{ok ? <IconCheck size={14} color="var(--mantine-color-teal-6)" /> : <IconX size={14} color="var(--mantine-color-red-6)" />}</Table.Td>
    <Table.Td ff="monospace">{label}</Table.Td>
    <Table.Td ff="monospace" c="dimmed">
      {extra}
    </Table.Td>
  </Table.Tr>
);
