import { ActionIcon, Badge, Button, Card, Grid, Group, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconDeviceFloppy, IconRestore, IconTrash, IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { attempt, useEvent, useLoad } from '../hooks.ts';
import { CodeEditor } from '../components/common.tsx';

export function StatePage() {
  const [text, setText] = useState('{}');
  const [dirty, setDirty] = useState(false);
  const [changedRemotely, setChangedRemotely] = useState(false);
  const snaps = useLoad(api.snapshots);
  const [snapName, setSnapName] = useState('');

  const load = async () => {
    const s = await attempt(api.state);
    if (s) {
      setText(JSON.stringify(s, null, 2));
      setDirty(false);
      setChangedRemotely(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  useEvent('state', () => {
    if (dirty) setChangedRemotely(true);
    else load();
  });

  const save = async () => {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch (e) {
      return attempt(() => Promise.reject(new Error('JSON non valido: ' + (e as Error).message)));
    }
    if (await attempt(() => api.replaceState(v as Record<string, unknown>), 'Stato salvato')) load();
  };

  return (
    <Grid>
      <Grid.Col span={{ base: 12, md: 8 }}>
        <Stack>
          <Group justify="space-between">
            <Group gap="xs">
              <Title order={3}>Stato condiviso</Title>
              {dirty && <Badge color="yellow">modificato</Badge>}
              {changedRemotely && (
                <Badge color="orange" variant="light">
                  cambiato da una richiesta
                </Badge>
              )}
            </Group>
            <Group gap="xs">
              <Button variant="default" size="xs" leftSection={<IconRefresh size={14} />} onClick={load}>
                Ricarica
              </Button>
              <Button
                variant="default"
                color="red"
                size="xs"
                leftSection={<IconTrash size={14} />}
                onClick={() => confirm('Svuotare completamente lo stato?') && attempt(api.clearState, 'Stato svuotato').then(load)}
              >
                Svuota
              </Button>
              <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} onClick={save} disabled={!dirty}>
                Salva
              </Button>
            </Group>
          </Group>
          <Text size="sm" c="dimmed">
            Lo stato è un unico documento JSON condiviso da tutti i mock e dalle pagine di flusso, salvato su SQLite. Si aggiorna in
            tempo reale quando i mock lo modificano.
          </Text>
          <CodeEditor
            value={text}
            onChange={(v) => {
              setText(v);
              setDirty(true);
            }}
            height="calc(100vh - 220px)"
          />
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 4 }}>
        <Card withBorder>
          <Stack>
            <Title order={5}>Snapshot</Title>
            <Text size="xs" c="dimmed">
              Salva lo stato attuale per ripristinarlo in seguito (es. prima di un test).
            </Text>
            <Group gap="xs">
              <TextInput size="xs" placeholder="nome snapshot" value={snapName} onChange={(e) => setSnapName(e.currentTarget.value)} style={{ flex: 1 }} />
              <Button
                size="xs"
                disabled={!snapName.trim()}
                onClick={() => attempt(() => api.saveSnapshot(snapName.trim()), 'Snapshot salvato').then(() => (setSnapName(''), snaps.reload()))}
              >
                Salva
              </Button>
            </Group>
            <Table fz="sm">
              <Table.Tbody>
                {(snaps.data ?? []).map((s) => (
                  <Table.Tr key={s.id}>
                    <Table.Td>
                      <Text size="sm">{s.name}</Text>
                      <Text size="xs" c="dimmed">
                        {new Date(s.createdAt).toLocaleString('it-IT')}
                      </Text>
                    </Table.Td>
                    <Table.Td w={70}>
                      <Group gap={2}>
                        <Tooltip label="Ripristina">
                          <ActionIcon
                            variant="subtle"
                            onClick={() => confirm(`Ripristinare "${s.name}"? Lo stato attuale verrà sovrascritto.`) && attempt(() => api.restoreSnapshot(s.id), 'Ripristinato').then(load)}
                          >
                            <IconRestore size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <ActionIcon variant="subtle" color="red" onClick={() => attempt(() => api.deleteSnapshot(s.id)).then(() => snaps.reload())}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        </Card>
      </Grid.Col>
    </Grid>
  );
}
