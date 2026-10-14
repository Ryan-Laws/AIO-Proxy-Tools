import { ListChecksIcon, Loader2Icon, PackageIcon, ScrollTextIcon, SlidersHorizontalIcon, WrenchIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { setTab, useApp, type TabKey } from "@/store/store";
import { ServerHeader } from "@/features/servers/ServerHeader";
import { IpTab } from "@/features/ips/IpTab";
import { SettingsTab } from "@/features/settings/SettingsTab";
import { LogsTab } from "@/features/deploy/LogsTab";
import { ProxiesTab } from "@/features/proxies/ProxiesTab";
import { ManageTab } from "@/features/manage/ManageTab";
import { t } from "@/i18n";

export function Workspace({ id }: { id: string }) {
  const s = useApp((st) => st.servers[id]);
  const storedTab = useApp((st) => st.tabs[id]);
  const task = useApp((st) => (s?.taskId ? st.tasks[s.taskId] : undefined));
  const sel = useApp((st) => (st.selection[id] ?? st.servers[id]?.selected ?? []).length);
  if (!s) return null;
  const busy = !!s.taskId && (!task || task.state === "running");
  const tab: TabKey = storedTab ?? (s.manifest ? "proxies" : s.taskId && !s.info ? "logs" : s.info ? "ips" : "logs");
  const nProxies = s.manifest?.proxies?.length ?? 0;
  const nIps = s.info?.addrs?.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ServerHeader s={s} task={task} />
      <Tabs value={tab} onValueChange={(v) => setTab(id, v as TabKey)} className="flex min-h-0 flex-1 flex-col">
        <div className="overflow-x-auto border-b px-4 py-2 scrollbar-thin md:px-6">
          <TabsList className="w-max">
            <TabsTrigger value="ips">
              <ListChecksIcon />
              {t("tab.ips")}
              {nIps > 0 && (
                <Badge variant="muted" className="tabular">
                  {sel}/{nIps}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="settings">
              <SlidersHorizontalIcon />
              {t("tab.settings")}
            </TabsTrigger>
            <TabsTrigger value="logs">
              {busy ? <Loader2Icon className="animate-spin text-primary" /> : <ScrollTextIcon />}
              {t("tab.logs")}
            </TabsTrigger>
            <TabsTrigger value="proxies">
              <PackageIcon />
              {t("tab.proxies")}
              {nProxies > 0 && (
                <Badge variant="success" className="tabular">
                  {nProxies}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="manage">
              <WrenchIcon />
              {t("tab.manage")}
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <TabsContent value="ips" className="h-full">
            <IpTab s={s} busy={busy} />
          </TabsContent>
          <TabsContent value="settings">
            {s.info ? <SettingsTab key={s.id} s={s} busy={busy} /> : <IpTab s={s} busy={busy} />}
          </TabsContent>
          <TabsContent value="logs" className="h-full">
            <LogsTab s={s} />
          </TabsContent>
          <TabsContent value="proxies" className="h-full">
            <ProxiesTab s={s} busy={busy} />
          </TabsContent>
          <TabsContent value="manage">
            <ManageTab s={s} busy={busy} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
