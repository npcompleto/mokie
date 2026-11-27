import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Code,
  Divider,
  Grid,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconExternalLink, IconPlus, IconTrash } from '@tabler/icons-react';
import type { Cta, FlowPage, FlowPageInput } from '@mokie/shared';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { attempt, navigate, useEvent, useLoad } from '../hooks.ts';
import { CodeEditor, EffectsEditor, KeyValueEditor } from '../components/common.tsx';

const NEW_PAGE: FlowPageInput = {
  slug: 'payment',
  title: 'Pagamento simulato',
  description: "Scegli l'esito da simulare.",
  redirectTemplate: '{{ctx.redirectUrl}}',
  ttlSeconds: 3600,
  ctas: [
    { id: 'ok', label: 'Conferma', color: 'green', outcome: 'Esito positivo', redirectParams: { status: 'OK' }, effects: [], delayMs: 0 },
    { id: 'ko', label: 'Rifiuta', color: 'red', outcome: 'Esito negativo', redirectParams: { status: 'KO', code: 'DECLINED' }, effects: [], delayMs: 0 },
  ],
};

export function FlowsPage({ id }: { id?: string }) {
  const pages = useLoad(api.flowPages);
  const sessions = useLoad(api.flowSessions);
  useEvent('config', (w: string) => (w === 'flows' || w === 'import') && pages.reload());
  useEvent('traffic', (t: { source: string }) => t.source === 'flow' && sessions.reload());

  return (
    <Grid>
      <Grid.Col span={{ base: 12, md: 3 }}>
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={3}>Flussi</Title>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => navigate('flows/new')}>
              Nuova pagina
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            Pagine web servite da Mokie con pulsanti (CTA) per simulare esiti: un mock genera l'URL con{' '}
            <Code>{"{{flowUrl 'slug' redirectUrl=…}}"}</Code>, la CTA applica effetti allo stato e reindirizza al redirect URL.
          </Text>
          {(pages.data ?? []).map((p) => (
            <UnstyledButton
              key={p.id}
              onClick={() => navigate(`flows/${p.id}`)}
              p="xs"
              style={{ borderRadius: 6, border: '1px solid var(--mantine-color-default-border)', background: String(p.id) === id ? 'var(--mantine-color-violet-light)' : undefined }}
            >
              <Text size="sm" fw={600}>
                {p.title}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {p.slug} · {p.ctas.length} CTA
              </Text>
            </UnstyledButton>
          ))}
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 9 }}>
        <Stack>
          {id ? (
            <FlowEditor
              key={id}
              id={id}
              page={pages.data?.find((p) => String(p.id) === id)}
              loaded={!!pages.data}
              onSaved={(p) => {
                pages.reload();
                navigate(`flows/${p.id}`);
              }}
              onDeleted={() => {
                pages.reload();
                navigate('flows');
              }}
              onSession={() => sessions.reload()}
            />
          ) : (
            <Card withBorder p="xl">
              <Text c="dimmed" ta="center">
                Seleziona una pagina di flusso o creane una nuova.
              </Text>
            </Card>
          )}
          <Card withBorder>
            <Group justify="space-between" mb="xs">
              <Title order={5}>Sessioni recenti</Title>
              <Button size="xs" variant="subtle" color="red" onClick={() => attempt(api.clearFlowSessions).then(() => sessions.reload())}>
                Svuota
              </Button>
            </Group>
            <Table fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Creata</Table.Th>
                  <Table.Th>Pagina</Table.Th>
                  <Table.Th>Stato</Table.Th>
                  <Table.Th>CTA</Table.Th>
                  <Table.Th>Contesto</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(sessions.data ?? []).slice(0, 30).map((s) => (
                  <Table.Tr key={s.token}>
                    <Table.Td>{new Date(s.createdAt).toLocaleTimeString('it-IT')}</Table.Td>
                    <Table.Td ff="monospace">{s.pageSlug}</Table.Td>
                    <Table.Td>
                      <Badge size="xs" color={s.status === 'completed' ? 'teal' : s.status === 'expired' ? 'gray' : 'yellow'}>
                        {s.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td ff="monospace">{s.chosenCta ?? '—'}</Table.Td>
                    <Table.Td ff="monospace" style={{ wordBreak: 'break-all' }}>
                      {JSON.stringify(s.context)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

function FlowEditor({
  id,
  page,
  loaded,
  onSaved,
  onDeleted,
  onSession,
}: {
  id: string;
  page?: FlowPage;
  loaded: boolean;
  onSaved: (p: FlowPage) => void;
  onDeleted: () => void;
  onSession: () => void;
}) {
  const isNew = id === 'new';
  const [form, setForm] = useState<FlowPageInput | null>(isNew ? NEW_PAGE : null);
  const [testCtx, setTestCtx] = useState('{\n  "redirectUrl": "https://example.com/callback",\n  "orderId": "123"\n}');
  useEffect(() => {
    if (!isNew && page) {
      const { id: _id, ...rest } = page;
      setForm(rest);
    }
  }, [isNew, page]);
  if (!form) return loaded && !isNew ? <Text c="dimmed">Pagina non trovata.</Text> : null;

  const set = (patch: Partial<FlowPageInput>) => setForm({ ...form, ...patch });
  const setCta = (i: number, patch: Partial<Cta>) => set({ ctas: form.ctas.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const move = (i: number, d: number) => {
    const ctas = [...form.ctas];
    const [c] = ctas.splice(i, 1);
    ctas.splice(i + d, 0, c);
    set({ ctas });
  };

  const save = async () => {
    const r = await attempt(() => (isNew ? api.createFlowPage(form) : api.updateFlowPage(Number(id), form)), 'Pagina salvata');
    if (r) onSaved(r);
  };
  const tryIt = async () => {
    let ctx: Record<string, unknown>;
    try {
      ctx = JSON.parse(testCtx || '{}');
    } catch {
      return attempt(() => Promise.reject(new Error('Contesto: JSON non valido')));
    }
    const s = await attempt(() => api.testFlowSession(Number(id), ctx));
    if (s) {
      window.open(s.url, '_blank');
      onSession();
    }
  };

  return (
    <Card withBorder>
      <Stack>
        <Group grow align="flex-start">
          <TextInput label="Titolo" value={form.title} onChange={(e) => set({ title: e.currentTarget.value })} />
          <TextInput label="Slug" description="usato in {{flowUrl 'slug'}}" className="mono" value={form.slug} onChange={(e) => set({ slug: e.currentTarget.value })} />
          <NumberInput label="Durata sessione (s)" description="0 = nessuna scadenza" min={0} value={form.ttlSeconds} onChange={(v) => set({ ttlSeconds: Number(v) || 0 })} />
        </Group>
        <Textarea label="Descrizione" autosize minRows={2} value={form.description} onChange={(e) => set({ description: e.currentTarget.value })} />
        <TextInput
          label="Redirect URL (template)"
          description="Contesto della sessione in ctx.* (i parametri passati a flowUrl). Default: {{ctx.redirectUrl}}"
          className="mono"
          value={form.redirectTemplate}
          onChange={(e) => set({ redirectTemplate: e.currentTarget.value })}
        />

        <Divider label="Azioni (CTA)" labelPosition="left" />
        {form.ctas.map((c, i) => (
          <Paper key={i} withBorder p="sm">
            <Stack gap="xs">
              <Group gap="xs" align="flex-end">
                <TextInput size="xs" label="ID" w={120} className="mono" value={c.id} onChange={(e) => setCta(i, { id: e.currentTarget.value })} />
                <TextInput size="xs" label="Etichetta" style={{ flex: 1 }} value={c.label} onChange={(e) => setCta(i, { label: e.currentTarget.value })} />
                <TextInput size="xs" label="Esito (sottotitolo)" style={{ flex: 1 }} value={c.outcome} onChange={(e) => setCta(i, { outcome: e.currentTarget.value })} />
                <Select
                  size="xs"
                  label="Colore"
                  w={100}
                  data={['green', 'red', 'orange', 'blue', 'gray']}
                  value={c.color}
                  onChange={(v) => setCta(i, { color: (v ?? 'blue') as Cta['color'] })}
                  allowDeselect={false}
                />
                <NumberInput size="xs" label="Ritardo ms" w={90} min={0} value={c.delayMs} onChange={(v) => setCta(i, { delayMs: Number(v) || 0 })} />
                <Group gap={2}>
                  <ActionIcon variant="subtle" disabled={i === 0} onClick={() => move(i, -1)}>
                    <IconArrowUp size={14} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" disabled={i === form.ctas.length - 1} onClick={() => move(i, 1)}>
                    <IconArrowDown size={14} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="red" onClick={() => set({ ctas: form.ctas.filter((_, j) => j !== i) })}>
                    <IconTrash size={14} />
                  </ActionIcon>
                </Group>
              </Group>
              <Grid>
                <Grid.Col span={5}>
                  <Text size="xs" fw={500} mb={4}>
                    Parametri aggiunti al redirect
                  </Text>
                  <KeyValueEditor value={c.redirectParams} onChange={(redirectParams) => setCta(i, { redirectParams })} keyLabel="param" valueLabel="valore / {{ctx.x}}" />
                </Grid.Col>
                <Grid.Col span={7}>
                  <Text size="xs" fw={500} mb={4}>
                    Effetti sullo stato
                  </Text>
                  <EffectsEditor value={c.effects} onChange={(effects) => setCta(i, { effects })} />
                </Grid.Col>
              </Grid>
            </Stack>
          </Paper>
        ))}
        <Button
          variant="light"
          size="xs"
          w="fit-content"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            set({
              ctas: [
                ...form.ctas,
                { id: `ko-${form.ctas.length}`, label: 'Nuovo esito', color: 'orange', outcome: '', redirectParams: { status: 'KO' }, effects: [], delayMs: 0 },
              ],
            })
          }
        >
          Aggiungi CTA
        </Button>

        {!isNew && (
          <>
            <Divider label="Prova" labelPosition="left" />
            <Group align="flex-end">
              <div style={{ flex: 1 }}>
                <Text size="xs" fw={500} mb={4}>
                  Contesto di test (ctx)
                </Text>
                <CodeEditor value={testCtx} onChange={setTestCtx} height="90px" />
              </div>
              <Button variant="default" leftSection={<IconExternalLink size={14} />} onClick={tryIt}>
                Apri pagina di test
              </Button>
            </Group>
          </>
        )}

        <Group justify="space-between">
          {!isNew ? (
            <Button
              variant="subtle"
              color="red"
              leftSection={<IconTrash size={14} />}
              onClick={() => confirm('Eliminare questa pagina?') && attempt(() => api.deleteFlowPage(Number(id))).then(onDeleted)}
            >
              Elimina
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={save}>{isNew ? 'Crea pagina' : 'Salva'}</Button>
        </Group>
      </Stack>
    </Card>
  );
}
