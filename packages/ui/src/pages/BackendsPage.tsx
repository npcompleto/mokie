import { ActionIcon, Badge, Button, Group, Modal, NumberInput, SegmentedControl, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import type { Backend, BackendInput } from '@mokie/shared';
import { useState } from 'react';
import { api } from '../api/client.ts';
import { attempt, useLoad } from '../hooks.ts';
import { KeyValueEditor } from '../components/common.tsx';

const EMPTY: BackendInput = {
  name: '',
  baseUrl: 'http://localhost:3000',
  matchType: 'prefix',
  matchValue: '/',
  stripPrefix: false,
  enabled: true,
  priority: 0,
  headersOverride: {},
};

export function BackendsPage() {
  const list = useLoad(api.backends);
  const [edit, setEdit] = useState<{ id?: number; form: BackendInput } | null>(null);

  const save = async () => {
    if (!edit) return;
    const r = await attempt(() => (edit.id ? api.updateBackend(edit.id, edit.form) : api.createBackend(edit.form)), 'Backend salvato');
    if (r) {
      setEdit(null);
      list.reload();
    }
  };
  const set = (patch: Partial<BackendInput>) => edit && setEdit({ ...edit, form: { ...edit.form, ...patch } });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Backend</Title>
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEdit({ form: { ...EMPTY } })}>
          Aggiungi backend
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Le richieste senza un mock attivo vengono inoltrate al backend corrispondente: prima per header Host, poi per prefisso di path
        più lungo. Senza backend corrispondente si risponde con il fallback configurato nelle impostazioni.
      </Text>
      <Table highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Nome</Table.Th>
            <Table.Th>Match</Table.Th>
            <Table.Th>Destinazione</Table.Th>
            <Table.Th>Attivo</Table.Th>
            <Table.Th w={80} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(list.data ?? []).map((b: Backend) => (
            <Table.Tr key={b.id}>
              <Table.Td fw={600}>{b.name}</Table.Td>
              <Table.Td ff="monospace">
                <Badge variant="light" size="sm" mr={6}>
                  {b.matchType}
                </Badge>
                {b.matchValue}
                {b.stripPrefix && (
                  <Text span size="xs" c="dimmed" ml={6}>
                    (prefisso rimosso)
                  </Text>
                )}
              </Table.Td>
              <Table.Td ff="monospace">{b.baseUrl}</Table.Td>
              <Table.Td>
                <Switch
                  size="xs"
                  checked={b.enabled}
                  onChange={(e) => {
                    const { id, ...rest } = b;
                    attempt(() => api.updateBackend(id, { ...rest, enabled: e.currentTarget.checked })).then(() => list.reload());
                  }}
                />
              </Table.Td>
              <Table.Td>
                <Group gap={2}>
                  <ActionIcon
                    variant="subtle"
                    onClick={() => {
                      const { id, ...form } = b;
                      setEdit({ id, form });
                    }}
                  >
                    <IconPencil size={16} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => confirm(`Eliminare il backend "${b.name}"?`) && attempt(() => api.deleteBackend(b.id)).then(() => list.reload())}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
          {list.data?.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={5}>
                <Text c="dimmed" ta="center" py="md">
                  Nessun backend configurato.
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>

      <Modal opened={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Modifica backend' : 'Nuovo backend'} size="lg">
        {edit && (
          <Stack>
            <TextInput label="Nome" value={edit.form.name} onChange={(e) => set({ name: e.currentTarget.value })} data-autofocus />
            <TextInput label="URL base" className="mono" value={edit.form.baseUrl} onChange={(e) => set({ baseUrl: e.currentTarget.value })} />
            <Group align="flex-end">
              <SegmentedControl
                value={edit.form.matchType}
                onChange={(v) => set({ matchType: v as 'prefix' | 'host' })}
                data={[
                  { value: 'prefix', label: 'Prefisso path' },
                  { value: 'host', label: 'Header Host' },
                ]}
              />
              <TextInput
                style={{ flex: 1 }}
                className="mono"
                label={edit.form.matchType === 'prefix' ? 'Prefisso (/ = tutto)' : 'Host (es. api.local:8080)'}
                value={edit.form.matchValue}
                onChange={(e) => set({ matchValue: e.currentTarget.value })}
              />
              <NumberInput label="Priorità" w={90} value={edit.form.priority} onChange={(v) => set({ priority: Number(v) || 0 })} />
            </Group>
            {edit.form.matchType === 'prefix' && (
              <Switch
                label="Rimuovi il prefisso prima di inoltrare (es. /api/users → /users)"
                checked={edit.form.stripPrefix}
                onChange={(e) => set({ stripPrefix: e.currentTarget.checked })}
              />
            )}
            <div>
              <Text size="sm" fw={500} mb={4}>
                Header da aggiungere/sovrascrivere
              </Text>
              <KeyValueEditor value={edit.form.headersOverride} onChange={(headersOverride) => set({ headersOverride })} />
            </div>
            <Group justify="flex-end">
              <Button onClick={save}>Salva</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
