import * as React from "react";
import { AlertTriangleIcon, ClipboardListIcon, FileSpreadsheetIcon, ListChecksIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { ServerInput } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Callout, Field } from "@/components/common";
import { noteTask, run, selectServer, upsertServers } from "@/store/store";
import { csvToServerLines } from "@/lib/csv";
import { readFileText, useDebounced } from "@/lib/dom";
import { t } from "@/i18n";

export function PasteDialog({
  open,
  onOpenChange,
  initialText,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialText?: string;
}) {
  const [text, setText] = React.useState("");
  const [port, setPort] = React.useState(22);
  const [user, setUser] = React.useState("root");
  const [parsed, setParsed] = React.useState<ServerInput[] | null>(null);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setText(initialText ?? "");
      setParsed(null);
      setErrors([]);
    }
  }, [open, initialText]);

  // 输入变化后自动解析预览
  const dText = useDebounced(text, 500);
  React.useEffect(() => {
    if (!open) return;
    if (!dText.trim()) {
      setParsed(null);
      setErrors([]);
      return;
    }
    let stale = false;
    api
      .parseServers(dText, { port, user, authType: "password" })
      .then((r) => {
        if (stale) return;
        setParsed(r.servers ?? []);
        setErrors(r.errors ?? []);
      })
      .catch((e: Error) => !stale && setErrors([e.message]));
    return () => {
      stale = true;
    };
  }, [dText, port, user, open]);

  const onCsv = async (file?: File) => {
    if (!file) return;
    const lines = csvToServerLines(await readFileText(file));
    setText((cur) => (cur.trim() ? cur.trimEnd() + "\n" : "") + lines.join("\n"));
    toast.success(t("paste.csvLoaded", { n: lines.length }));
  };

  const add = async () => {
    if (!parsed?.length) return toast.error(t("paste.empty"));
    setBusy(true);
    const list = await run(api.addServers(parsed));
    setBusy(false);
    if (!list?.length) return;
    upsertServers(list);
    selectServer(list[0].id);
    onOpenChange(false);
    const ids = list.map((s) => s.id);
    const r = await run(api.batch("detect", ids), t("add.added", { n: list.length }));
    if (r) for (const [sid, tid] of Object.entries(r.taskIds)) noteTask(sid, tid, "detect");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardListIcon className="size-5 text-primary" />
            {t("paste.title")}
          </DialogTitle>
          <DialogDescription>{t("paste.desc")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("paste.defPort")} htmlFor="paste-port" className="w-24">
              <Input id="paste-port" inputMode="numeric" value={port || ""} onChange={(e) => setPort(Number(e.target.value.replace(/\D/g, "")) || 0)} />
            </Field>
            <Field label={t("paste.defUser")} htmlFor="paste-user" className="w-32">
              <Input id="paste-user" value={user} onChange={(e) => setUser(e.target.value)} />
            </Field>
            <div className="ml-auto">
              <input ref={fileRef} type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => void onCsv(e.target.files?.[0])} />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <FileSpreadsheetIcon />
                {t("paste.importCsv")}
              </Button>
            </div>
          </div>
          <Textarea
            aria-label={t("paste.title")}
            rows={7}
            className="font-mono text-xs leading-relaxed"
            placeholder={t("paste.ph")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />

          {errors.length > 0 && (
            <Callout tone="warning" icon={<AlertTriangleIcon />}>
              <div className="font-medium">{t("paste.errors")}</div>
              <ul className="mt-1 max-h-24 list-disc overflow-auto pl-4 text-xs scrollbar-thin">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Callout>
          )}

          {parsed && parsed.length > 0 && (
            <div className="rounded-lg border">
              <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                <ListChecksIcon className="size-4" />
                {t("paste.rows", { n: parsed.length })}
              </div>
              <div className="max-h-56 overflow-auto scrollbar-thin">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>{t("add.host")}</TableHead>
                      <TableHead>{t("add.port")}</TableHead>
                      <TableHead>{t("add.user")}</TableHead>
                      <TableHead>{t("add.password")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.map((s, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-muted-foreground tabular">{i + 1}</TableCell>
                        <TableCell className="font-mono text-xs">{s.host}</TableCell>
                        <TableCell className="tabular">{s.port}</TableCell>
                        <TableCell>{s.user}</TableCell>
                        <TableCell>
                          {s.password ? (
                            <span className="font-mono text-xs text-muted-foreground">••••••</span>
                          ) : (
                            <Badge variant="warning">{t("paste.noPass")}</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void add()} disabled={busy || !parsed?.length}>
            {t("paste.add", { n: parsed?.length ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
