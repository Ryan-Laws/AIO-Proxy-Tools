import * as React from "react";
import { PlusCircleIcon } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { noteTask, run } from "@/store/store";
import { isValidAddrSpec } from "@/lib/ip";
import { t } from "@/i18n";

export function ManualAddDialog({ open, onOpenChange, serverId }: { open: boolean; onOpenChange: (v: boolean) => void; serverId: string }) {
  const [text, setText] = React.useState("");
  const [bind, setBind] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) setText("");
  }, [open]);

  const items = text
    .split(/[\s,;，；]+/)
    .map((x) => x.trim().replace(/\s*-\s*/, "-"))
    .filter(Boolean);
  const bad = items.filter((x) => !isValidAddrSpec(x));

  const submit = async () => {
    setBusy(true);
    const r = await run(api.probe(serverId, items, bind));
    setBusy(false);
    if (!r) return;
    noteTask(serverId, r.taskId, "probe");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlusCircleIcon className="size-5 text-primary" />
            {t("manual.title")}
          </DialogTitle>
          <DialogDescription>{t("manual.desc")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Textarea
            rows={6}
            autoFocus
            aria-label={t("manual.title")}
            className="font-mono text-xs leading-relaxed"
            placeholder={t("manual.ph")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={bad.length > 0 || undefined}
            spellCheck={false}
          />
          <div className="flex justify-between text-xs">
            {bad.length ? (
              <span className="text-destructive">{t("manual.invalid", { list: bad.slice(0, 5).join("、") })}</span>
            ) : (
              <span className="text-muted-foreground">{items.length ? t("manual.count", { n: items.length }) : ""}</span>
            )}
          </div>
          <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
            <Checkbox id="manual-bind" checked={bind} onCheckedChange={(v) => setBind(v === true)} className="mt-0.5" />
            <div className="grid gap-1">
              <Label htmlFor="manual-bind" className="cursor-pointer text-[13px]">
                {t("manual.bind")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("manual.bindTip")}</p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !items.length || bad.length > 0}>
            {t("manual.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
