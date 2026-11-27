import { ActionIcon, Badge, Button, Group, Select, Stack, Text, TextInput, Tooltip, useComputedColorScheme } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { CONDITION_SOURCES, EFFECT_OPS, OPERATORS, type Condition, type Effect, type TrafficSource } from '@mokie/shared';

const METHOD_COLORS: Record<string, string> = {
  GET: 'blue',
  POST: 'green',
  PUT: 'orange',
  PATCH: 'yellow',
  DELETE: 'red',
  HEAD: 'gray',
  OPTIONS: 'gray',
  ANY: 'violet',
};
export const MethodBadge = ({ method }: { method: string }) => (
  <Badge color={METHOD_COLORS[method] ?? 'gray'} variant="light" radius="sm" w={72}>
    {method}
  </Badge>
);

const SOURCE_COLORS: Record<TrafficSource, string> = { mock: 'violet', proxy: 'blue', flow: 'teal', fallback: 'gray', error: 'red' };
export const SourceBadge = ({ source }: { source: TrafficSource }) => (
  <Badge color={SOURCE_COLORS[source]} variant="dot" radius="sm">
    {source}
  </Badge>
);

export const StatusText = ({ status }: { status: number }) => (
  <Text span fw={600} c={status >= 500 ? 'red' : status >= 400 ? 'orange' : status >= 300 ? 'cyan' : 'teal'} ff="monospace">
    {status}
  </Text>
);

export function CodeEditor({
  value,
  onChange,
  lang = 'json',
  height = '260px',
  readOnly,
  placeholder,
}: {
  value: string;
  onChange?: (v: string) => void;
  lang?: 'json' | 'js' | 'text';
  height?: string;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const scheme = useComputedColorScheme('light');
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height={height}
      theme={scheme}
      readOnly={readOnly}
      placeholder={placeholder}
      extensions={lang === 'json' ? [json()] : lang === 'js' ? [javascript()] : []}
      basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly }}
      style={{ fontSize: 13, border: '1px solid var(--mantine-color-default-border)', borderRadius: 6, overflow: 'hidden' }}
    />
  );
}

export function KeyValueEditor({
  value,
  onChange,
  keyLabel = 'Nome',
  valueLabel = 'Valore',
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  keyLabel?: string;
  valueLabel?: string;
}) {
  const entries = Object.entries(value);
  const update = (list: [string, string][]) => onChange(Object.fromEntries(list));
  return (
    <Stack gap={6}>
      {entries.map(([k, v], i) => (
        <Group key={i} gap={6} wrap="nowrap">
          <TextInput
            placeholder={keyLabel}
            value={k}
            onChange={(e) => update(entries.map((x, j) => (j === i ? [e.currentTarget.value, x[1]] : x)))}
            style={{ flex: 1 }}
            size="xs"
          />
          <TextInput
            placeholder={valueLabel}
            value={v}
            onChange={(e) => update(entries.map((x, j) => (j === i ? [x[0], e.currentTarget.value] : x)))}
            style={{ flex: 2 }}
            size="xs"
            className="mono"
          />
          <ActionIcon variant="subtle" color="red" onClick={() => update(entries.filter((_, j) => j !== i))}>
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Button
        size="xs"
        variant="subtle"
        leftSection={<IconPlus size={14} />}
        onClick={() => update([...entries, [entries.some(([k]) => k === '') ? `key${entries.length}` : '', '']])}
        w="fit-content"
      >
        Aggiungi
      </Button>
    </Stack>
  );
}

const SOURCE_HELP: Record<Condition['source'], string> = {
  header: 'nome header (case-insensitive)',
  query: 'nome parametro query',
  cookie: 'nome cookie',
  param: 'parametro del path (es. id per /orders/:id)',
  body: 'JSONPath, es. $.user.id (vuoto = body grezzo)',
  state: 'percorso stato, es. orders.{{params.id}}.status',
  script: '',
};
const NO_VALUE = new Set(['exists', 'notExists']);

export function ConditionsEditor({ value, onChange }: { value: Condition[]; onChange: (v: Condition[]) => void }) {
  const set = (i: number, patch: Partial<Condition>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <Stack gap={6}>
      {value.length === 0 && (
        <Text size="sm" c="dimmed">
          Nessuna condizione: il mock si attiva per ogni richiesta che corrisponde a metodo e path.
        </Text>
      )}
      {value.map((c, i) => (
        <Group key={i} gap={6} wrap="nowrap" align="flex-start">
          <Select
            size="xs"
            w={110}
            data={CONDITION_SOURCES as unknown as string[]}
            value={c.source}
            onChange={(v) => set(i, { source: (v ?? 'header') as Condition['source'] })}
            allowDeselect={false}
          />
          {c.source === 'script' ? (
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              className="mono"
              placeholder="espressione JS, es. body.amount > 100 && headers['x-env'] === 'test'"
              value={c.value}
              onChange={(e) => set(i, { value: e.currentTarget.value })}
            />
          ) : (
            <>
              <TextInput
                size="xs"
                style={{ flex: 1.3 }}
                className="mono"
                placeholder={SOURCE_HELP[c.source]}
                value={c.key}
                onChange={(e) => set(i, { key: e.currentTarget.value })}
              />
              <Select
                size="xs"
                w={120}
                data={OPERATORS as unknown as string[]}
                value={c.operator}
                onChange={(v) => set(i, { operator: (v ?? 'equals') as Condition['operator'] })}
                allowDeselect={false}
              />
              <TextInput
                size="xs"
                style={{ flex: 1 }}
                className="mono"
                placeholder={NO_VALUE.has(c.operator) ? '—' : 'valore (template ammessi)'}
                disabled={NO_VALUE.has(c.operator)}
                value={c.value}
                onChange={(e) => set(i, { value: e.currentTarget.value })}
              />
            </>
          )}
          <ActionIcon variant="subtle" color="red" mt={2} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Button
        size="xs"
        variant="light"
        leftSection={<IconPlus size={14} />}
        w="fit-content"
        onClick={() => onChange([...value, { source: 'header', key: '', operator: 'equals', value: '' }])}
      >
        Aggiungi condizione
      </Button>
    </Stack>
  );
}

const EFFECT_HELP: Record<Effect['op'], string> = {
  set: 'imposta il valore (JSON o testo)',
  merge: 'unisce un oggetto JSON',
  incr: 'incrementa (default 1)',
  push: 'aggiunge in coda a una lista',
  remove: 'cancella la chiave',
};

export function EffectsEditor({ value, onChange }: { value: Effect[]; onChange: (v: Effect[]) => void }) {
  const set = (i: number, patch: Partial<Effect>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <Stack gap={6}>
      {value.map((e, i) => (
        <Group key={i} gap={6} wrap="nowrap">
          <Tooltip label={EFFECT_HELP[e.op]}>
            <Select
              size="xs"
              w={100}
              data={EFFECT_OPS as unknown as string[]}
              value={e.op}
              onChange={(v) => set(i, { op: (v ?? 'set') as Effect['op'] })}
              allowDeselect={false}
            />
          </Tooltip>
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            className="mono"
            placeholder="percorso, es. orders.{{params.id}}"
            value={e.path}
            onChange={(ev) => set(i, { path: ev.currentTarget.value })}
          />
          <TextInput
            size="xs"
            style={{ flex: 1.5 }}
            className="mono"
            placeholder={e.op === 'remove' ? '—' : e.op === 'incr' ? '1' : 'valore, es. {"status":"NEW"} o {{json body}}'}
            disabled={e.op === 'remove'}
            value={e.value}
            onChange={(ev) => set(i, { value: ev.currentTarget.value })}
          />
          <ActionIcon variant="subtle" color="red" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Button
        size="xs"
        variant="light"
        leftSection={<IconPlus size={14} />}
        w="fit-content"
        onClick={() => onChange([...value, { op: 'set', path: '', value: '' }])}
      >
        Aggiungi effetto
      </Button>
    </Stack>
  );
}

export const prettyBody = (body: string, contentType?: string) => {
  if (!body) return '';
  if (/json/i.test(contentType ?? '') || /^\s*[[{]/.test(body)) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      /* raw */
    }
  }
  return body;
};

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('it-IT', { hour12: false }) + '.' + iso.slice(20, 23);
