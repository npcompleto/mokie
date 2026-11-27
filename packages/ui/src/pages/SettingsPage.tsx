import { Button, Card, Checkbox, FileButton, Group, NumberInput, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconDownload, IconUpload } from '@tabler/icons-react';
import type { Settings } from '@mokie/shared';
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { attempt, notifyOk, useLoad } from '../hooks.ts';

export function SettingsPage() {
  const loaded = useLoad(api.settings);
  const [s, setS] = useState<Settings | null>(null);
  const [withState, setWithState] = useState(false);
  const [replace, setReplace] = useState(false);
  useEffect(() => {
    if (loaded.data) setS(loaded.data);
  }, [loaded.data]);

  const exportIt = async () => {
    const b = await attempt(() => api.exportBundle(withState));
    if (!b) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `mokie-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importIt = async (file: File | null) => {
    if (!file) return;
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return attempt(() => Promise.reject(new Error('File JSON non valido')));
    }
    if (replace && !confirm('Modalità sostituzione: mock, collection, backend e pagine esistenti verranno eliminati. Continuare?')) return;
    const r = await attempt(() => api.importBundle(data, replace));
    if (r) notifyOk(`Importati: ${r.mocks} mock, ${r.flowPages} pagine, ${r.backends} backend, ${r.collections} collection`);
  };

  return (
    <Stack maw={720}>
      <Title order={3}>Impostazioni</Title>
      {s && (
        <Card withBorder>
          <Stack>
            <TextInput
              label="URL pubblico di Mokie"
              description="Base usata per gli URL delle pagine di flusso (es. http://mokie.local:8080). Vuoto = ricavato dall'header Host della richiesta."
              className="mono"
              value={s.publicUrl}
              onChange={(e) => setS({ ...s, publicUrl: e.currentTarget.value })}
            />
            <Group grow>
              <NumberInput
                label="Richieste conservate nel log"
                min={0}
                step={1000}
                value={s.trafficRetention}
                onChange={(v) => setS({ ...s, trafficRetention: Number(v) || 0 })}
              />
              <NumberInput
                label="Dimensione max body nel log (KB)"
                min={1}
                value={Math.round(s.maxBodyBytes / 1024)}
                onChange={(v) => setS({ ...s, maxBodyBytes: (Number(v) || 1) * 1024 })}
              />
            </Group>
            <Select
              label="Se nessun mock e nessun backend corrispondono"
              data={[
                { value: 'notFound', label: '404 Not Found' },
                { value: 'badGateway', label: '502 Bad Gateway' },
              ]}
              value={s.noBackendFallback}
              onChange={(v) => setS({ ...s, noBackendFallback: (v ?? 'notFound') as Settings['noBackendFallback'] })}
              allowDeselect={false}
            />
            <Group justify="flex-end">
              <Button onClick={() => attempt(() => api.saveSettings(s), 'Impostazioni salvate')}>Salva</Button>
            </Group>
          </Stack>
        </Card>
      )}
      <Card withBorder>
        <Stack>
          <Title order={5}>Import / Export</Title>
          <Text size="sm" c="dimmed">
            Esporta backend, collection, mock e pagine di flusso in un file JSON versionabile in git. Un esempio completo è in{' '}
            <code>examples/payment-flow.json</code>.
          </Text>
          <Group>
            <Checkbox label="includi lo stato" checked={withState} onChange={(e) => setWithState(e.currentTarget.checked)} />
            <Button variant="default" leftSection={<IconDownload size={14} />} onClick={exportIt}>
              Esporta
            </Button>
          </Group>
          <Group>
            <Checkbox label="sostituisci tutto (invece di aggiungere)" checked={replace} onChange={(e) => setReplace(e.currentTarget.checked)} />
            <FileButton onChange={importIt} accept="application/json">
              {(props) => (
                <Button variant="default" leftSection={<IconUpload size={14} />} {...props}>
                  Importa…
                </Button>
              )}
            </FileButton>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
