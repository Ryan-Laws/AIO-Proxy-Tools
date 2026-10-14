import * as React from "react";
import { ClipboardCopyIcon, DownloadIcon, FileDownIcon, FileSpreadsheetIcon, InfoIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/common";
import { useApp } from "@/store/store";
import {
  buildRows,
  CSV_HEADER,
  DEFAULT_TEMPLATE,
  fileSafe,
  filterRows,
  renderExport,
  type ExportFormat,
  type ExportOptions,
  type ProtoFilter,
} from "@/lib/export";
import { copyText, downloadText, stamp } from "@/lib/dom";
import { t, type MessageKey } from "@/i18n";

const KEY = "aio-export";

function loadOpts(): ExportOptions {
  const d: ExportOptions = { format: "url", proto: "all", onlyPassed: false, template: DEFAULT_TEMPLATE };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ExportOptions> | null;
    return v ? { ...d, ...v } : d;
  } catch {
    return d;
  }
}

const FORMATS: ExportFormat[] = ["colon", "at", "url", "csv", "template"];

export function ExportDialog({
  open,
  onOpenChange,
  fixedIds,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 指定服务器（单台导出）；不传则为「全部导出」 */
  fixedIds?: string[];
}) {
  const servers = useApp((s) => s.servers);
  const order = useApp((s) => s.order);
  const checked = useApp((s) => s.checked);
  const [o, setO] = React.useState<ExportOptions>(loadOpts);
  const [scope, setScope] = React.useState<"all" | "checked">("all");
  const [mode, setMode] = React.useState<"merge" | "split">("merge");
  const all = !fixedIds;

  React.useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(o));
    } catch {
      /* ignore */
    }
  }, [o]);
  React.useEffect(() => {
    if (open && all) setScope(checked.length ? "checked" : "all");
  }, [open, all, checked.length]);

  const ids = fixedIds ?? (scope === "checked" ? order.filter((id) => checked.includes(id)) : order);
  const perServer = React.useMemo(
    () =>
      ids
        .map((id) => servers[id])
        .filter((s) => s?.manifest?.proxies?.length)
        .map((s) => ({ s, rows: buildRows(s) })),
    [ids.join(","), servers], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const up = (p: Partial<ExportOptions>) => setO((x) => ({ ...x, ...p }));

  const count = perServer.reduce((n, x) => n + filterRows(x.rows, o).length, 0);
  const mergedText = (opts: ExportOptions) => {
    if (opts.format === "csv") {
      const body = perServer.map((x) => renderExport(x.rows, opts, false)).filter(Boolean);
      return [CSV_HEADER.join(","), ...body].join("\n");
    }
    if (all && mode === "split") {
      return perServer
        .map((x) => {
          const txt = renderExport(x.rows, opts);
          return txt ? `# ${x.s.name || x.s.host}\n${txt}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
    }
    return perServer
      .map((x) => renderExport(x.rows, opts))
      .filter(Boolean)
      .join("\n");
  };
  const preview = React.useMemo(() => {
    const txt = mergedText(o);
    const lines = txt.split("\n");
    return lines.length > 300 ? lines.slice(0, 300).join("\n") + "\n" + t("exp.more", { n: lines.length - 300 }) : txt;
  }, [o, perServer, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = (csv: boolean) => {
    const opts: ExportOptions = csv ? { ...o, format: "csv" } : o;
    const ext = csv ? "csv" : "txt";
    const mime = csv ? "text/csv" : "text/plain";
    const protoTag = o.proto === "all" ? "" : `-${o.proto}`;
    if (!count) return toast.error(t("exp.noData"));
    if (all && mode === "split") {
      let n = 0;
      perServer.forEach((x, i) => {
        const txt = renderExport(x.rows, opts);
        if (!txt) return;
        n++;
        setTimeout(() => downloadText(`proxies-${fileSafe(x.s.name || x.s.host)}${protoTag}-${stamp()}.${ext}`, txt, mime), i * 350);
      });
      toast.success(t("exp.downloaded", { n }));
      return;
    }
    const base = perServer.length === 1 ? fileSafe(perServer[0].s.name || perServer[0].s.host) : "all";
    downloadText(`proxies-${base}${protoTag}-${stamp()}.${ext}`, mergedText(opts), mime);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DownloadIcon className="size-5 text-primary" />
            {all ? t("exp.allTitle") : t("exp.title")}
          </DialogTitle>
          {all && <DialogDescription>{t("exp.allDesc")}</DialogDescription>}
        </DialogHeader>

        <div className="grid gap-4">
          {all && (
            <div className="grid gap-4 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
              <Field label={t("exp.scope")}>
                <RadioGroup value={scope} onValueChange={(v) => setScope(v as "all" | "checked")}>
                  <Label className="cursor-pointer font-normal">
                    <RadioGroupItem value="all" />
                    {t("exp.scope.all")}
                  </Label>
                  <Label className="cursor-pointer font-normal">
                    <RadioGroupItem value="checked" disabled={!checked.length} />
                    {t("exp.scope.checked", { n: checked.length })}
                  </Label>
                </RadioGroup>
              </Field>
              <Field label={t("exp.mode")}>
                <RadioGroup value={mode} onValueChange={(v) => setMode(v as "merge" | "split")}>
                  <Label className="cursor-pointer font-normal">
                    <RadioGroupItem value="merge" />
                    {t("exp.mode.merge")}
                  </Label>
                  <Label className="cursor-pointer font-normal">
                    <RadioGroupItem value="split" />
                    {t("exp.mode.split")}
                  </Label>
                </RadioGroup>
              </Field>
            </div>
          )}

          <Field label={t("exp.format")}>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("exp.format")}>
              {FORMATS.map((f) => (
                <button
                  key={f}
                  role="radio"
                  aria-checked={o.format === f}
                  onClick={() => up({ format: f })}
                  className={
                    "cursor-pointer rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
                    (o.format === f ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-accent")
                  }
                >
                  {t(`exp.fmt.${f}` as MessageKey)}
                </button>
              ))}
            </div>
          </Field>

          {o.format === "template" && (
            <Field label={t("exp.template")} htmlFor="exp-tpl" hint={t("exp.templateHelp")}>
              <Input id="exp-tpl" className="font-mono text-xs" value={o.template} onChange={(e) => up({ template: e.target.value })} spellCheck={false} />
            </Field>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{t("exp.proto")}</span>
              <Tabs value={o.proto} onValueChange={(v) => up({ proto: v as ProtoFilter })}>
                <TabsList className="h-8">
                  {(["all", "socks", "http"] as ProtoFilter[]).map((p) => (
                    <TabsTrigger key={p} value={p} className="px-3 text-xs">
                      {t(`exp.proto.${p}` as MessageKey)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
            <Label className="cursor-pointer text-[13px] font-normal">
              <Checkbox checked={o.onlyPassed} onCheckedChange={(v) => up({ onlyPassed: v === true })} />
              {t("exp.onlyPassed")}
            </Label>
            <Badge variant="secondary" className="ml-auto tabular">
              {t("exp.lines", { n: count })}
            </Badge>
          </div>

          <Textarea
            readOnly
            aria-label={t("exp.title")}
            value={count ? preview : ""}
            placeholder={t("exp.noData")}
            rows={10}
            className="font-mono text-xs leading-relaxed whitespace-pre"
            onFocus={(e) => e.currentTarget.select()}
          />
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <InfoIcon className="size-3.5" />
            {t("exp.ipv6Note")} · {t("set.dns.hint")}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={!count} onClick={() => void copyText(mergedText(o))}>
            <ClipboardCopyIcon />
            {t("exp.copy")}
          </Button>
          <Button variant="outline" disabled={!count} onClick={() => download(true)}>
            <FileSpreadsheetIcon />
            {t("exp.csv")}
          </Button>
          <Button disabled={!count} onClick={() => download(o.format === "csv")}>
            <FileDownIcon />
            {o.format === "csv" ? t("exp.csv") : t("exp.txt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
