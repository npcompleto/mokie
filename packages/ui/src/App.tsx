import { ActionIcon, AppShell, Badge, Group, NavLink, Text, Title, Tooltip, useMantineColorScheme } from '@mantine/core';
import { IconArrowsExchange, IconDatabase, IconMoon, IconRoute, IconServer, IconSettings, IconSun, IconWand } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { api } from './api/client.ts';
import { MokieMark } from './components/Logo.tsx';
import { useRoute, navigate } from './hooks.ts';
import { TrafficPage } from './pages/TrafficPage.tsx';
import { MocksPage } from './pages/MocksPage.tsx';
import { StatePage } from './pages/StatePage.tsx';
import { FlowsPage } from './pages/FlowsPage.tsx';
import { BackendsPage } from './pages/BackendsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

const NAV = [
  { key: 'traffic', label: 'Traffico', icon: IconArrowsExchange },
  { key: 'mocks', label: 'Mock', icon: IconWand },
  { key: 'state', label: 'Stato', icon: IconDatabase },
  { key: 'flows', label: 'Flussi', icon: IconRoute },
  { key: 'backends', label: 'Backend', icon: IconServer },
  { key: 'settings', label: 'Impostazioni', icon: IconSettings },
];

export function App() {
  const route = useRoute();
  const page = route[0] ?? 'traffic';
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [proxyPort, setProxyPort] = useState<number>();
  useEffect(() => {
    api.health().then((h) => setProxyPort(h.port)).catch(() => {});
  }, []);

  return (
    <AppShell header={{ height: 52 }} navbar={{ width: 200, breakpoint: 0 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap={8}>
            <MokieMark size={30} />
            <Title order={3} style={{ letterSpacing: '-0.03em' }}>
              Mokie
            </Title>
            <Text c="red.7" size="sm" fw={500} style={{ letterSpacing: '0.2em' }}>
              モキ
            </Text>
          </Group>
          <Group gap="xs">
            {proxyPort && (
              <Tooltip label="Punta i tuoi client a questo indirizzo">
                <Badge variant="light" size="lg" radius="sm" tt="none" ff="monospace">
                  proxy · {location.hostname}:{proxyPort}
                </Badge>
              </Tooltip>
            )}
            <ActionIcon variant="default" onClick={() => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark')} aria-label="tema">
              {colorScheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {NAV.map((n) => (
          <NavLink
            key={n.key}
            label={n.label}
            leftSection={<n.icon size={18} stroke={1.6} />}
            active={page === n.key}
            onClick={() => navigate(n.key)}
            style={{ borderRadius: 6 }}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        {page === 'traffic' && <TrafficPage />}
        {page === 'mocks' && <MocksPage id={route[1]} />}
        {page === 'state' && <StatePage />}
        {page === 'flows' && <FlowsPage id={route[1]} />}
        {page === 'backends' && <BackendsPage />}
        {page === 'settings' && <SettingsPage />}
      </AppShell.Main>
    </AppShell>
  );
}
