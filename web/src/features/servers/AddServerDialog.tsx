import * as React from "react";
import { FileKeyIcon, KeyRoundIcon, ServerIcon, ShieldCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { ServerInput, ServerView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, PasswordInput } from "@/components/common";
import { Tip } from "@/components/ui/tooltip";
import { detect, run, selectServer, upsertServers, useApp } from "@/store/store";
import { VaultDialog } from "@/features/settings/VaultDialog";
import { readFileText } from "@/lib/dom";
import { t } from "@/i18n";

const empty: ServerInput = {
  name: "",
  host: "",
  port: 22,
  user: "root",
  authType: "password",
  password: "",
  key: "",
  passphrase: "",
  remember: false,
};

export function AddServerDialog({
  open,
  onOpenChange,
  edit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 传入则为编辑模式 */
  edit?: ServerView | null;
}) {
  const vault = useApp((s) => s.vault);
  const [f, setF] = React.useState<ServerInput>(empty);
  const [errors, setErrors] = React.useState<Partial<Record<keyof ServerInput, string>>>({});
  const [busy, setBusy] = React.useState(false);
  const [vaultMode, setVaultMode] = React.useState<"create" | "unlock" | null>(null);
  const [keyName, setKeyName] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setErrors({});
    setKeyName("");
    setF(
      edit
        ? { ...empty, name: edit.name, host: edit.host, port: edit.port, user: edit.user, authType: edit.authType, remember: edit.remember }
        : empty,
    );
  }, [open, edit]);

  const up = <K extends keyof ServerInput>(k: K, v: ServerInput[K]) => setF((p) => ({ ...p, [k]: v }));

  const validate = (): boolean => {
    const e: typeof errors = {};
    if (!f.host.trim()) e.host = t("add.needHost");
    if (!(f.port >= 1 && f.port <= 65535)) e.port = t("add.badPort");
    const needSecret = !edit || !edit.hasSecret;
    if (needSecret) {
      if (f.authType === "password" && !f.password) e.password = t("add.needSecret");
      if (f.authType === "key" && !f.key.trim()) e.key = t("add.needSecret");
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const doSubmit = async () => {
    setBusy(true);
    const input: ServerInput = {
      ...f,
      host: f.host.trim(),
      name: f.name.trim(),
      user: f.user.trim() || "root",
      password: f.authType === "password" ? f.password : "",
      key: f.authType === "key" ? f.key : "",
      passphrase: f.authType === "key" ? f.passphrase : "",
    };
    try {
      if (edit) {
        const v = await run(api.patchServer(edit.id, input));
        if (!v) return;
        upsertServers([v]);
        onOpenChange(false);
        void detect(edit.id);
      } else {
        const list = await run(api.addServers([input]));
        if (!list?.length) return;
        upsertServers(list);
        selectServer(list[0].id);
        onOpenChange(false);
        toast.success(t("add.added", { n: list.length }));
        for (const s of list) void detect(s.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    if (f.remember && !vault.unlocked) {
      setVaultMode(vault.exists ? "unlock" : "create");
      return;
    }
    void doSubmit();
  };

  const onKeyFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 64 * 1024) {
      toast.error(t("add.keyTooBig"));
      return;
    }
    const text = await readFileText(file);
    up("key", text);
    setKeyName(file.name);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <form onSubmit={submit} className="grid gap-4" autoComplete="off">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ServerIcon className="size-5 text-primary" />
                {edit ? t("ws.editServer") : t("add.title")}
              </DialogTitle>
              <DialogDescription>{t("add.desc")}</DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-6 gap-3">
              <Field label={t("add.host")} htmlFor="srv-host" error={errors.host} className="col-span-6 sm:col-span-4">
                <Input
                  id="srv-host"
                  autoFocus={!edit}
                  placeholder={t("add.hostPh")}
                  value={f.host}
                  aria-invalid={!!errors.host || undefined}
                  onChange={(e) => up("host", e.target.value)}
                  spellCheck={false}
                />
              </Field>
              <Field label={t("add.port")} htmlFor="srv-port" error={errors.port} className="col-span-3 sm:col-span-2">
                <Input
                  id="srv-port"
                  inputMode="numeric"
                  value={f.port || ""}
                  aria-invalid={!!errors.port || undefined}
                  onChange={(e) => up("port", Number(e.target.value.replace(/\D/g, "")) || 0)}
                />
              </Field>
              <Field label={t("add.user")} htmlFor="srv-user" className="col-span-3 sm:col-span-3">
                <Input id="srv-user" value={f.user} onChange={(e) => up("user", e.target.value)} spellCheck={false} />
              </Field>
              <Field label={<>{t("add.name")} <span className="font-normal text-muted-foreground">（{t("common.optional")}）</span></>} htmlFor="srv-name" className="col-span-6 sm:col-span-3">
                <Input id="srv-name" placeholder={t("add.namePh")} value={f.name} onChange={(e) => up("name", e.target.value)} />
              </Field>
            </div>
            {f.user.trim() && f.user.trim() !== "root" && <p className="-mt-2 text-xs text-muted-foreground">{t("add.nonRoot")}</p>}

            <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-[13px]">{t("add.authType")}</Label>
                <Tabs value={f.authType} onValueChange={(v) => up("authType", v)}>
                  <TabsList className="h-8">
                    <TabsTrigger value="password" className="text-xs">
                      <KeyRoundIcon className="size-3.5" />
                      {t("add.auth.password")}
                    </TabsTrigger>
                    <TabsTrigger value="key" className="text-xs">
                      <FileKeyIcon className="size-3.5" />
                      {t("add.auth.key")}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
              {f.authType === "password" ? (
                <Field htmlFor="srv-pass" error={errors.password} hint={edit?.hasSecret ? t("add.keepSecret") : undefined}>
                  <PasswordInput
                    id="srv-pass"
                    aria-label={t("add.password")}
                    placeholder={t("add.password")}
                    autoComplete="new-password"
                    value={f.password}
                    aria-invalid={!!errors.password || undefined}
                    onChange={(e) => up("password", e.target.value)}
                  />
                </Field>
              ) : (
                <>
                  <Field
                    htmlFor="srv-key"
                    error={errors.key}
                    hint={keyName ? t("add.keyLoaded", { name: keyName }) : edit?.hasSecret ? t("add.keepSecret") : undefined}
                    label={t("add.key")}
                    right={
                      <>
                        <input ref={fileRef} type="file" className="hidden" onChange={(e) => void onKeyFile(e.target.files?.[0])} />
                        <Button size="xs" variant="outline" onClick={() => fileRef.current?.click()}>
                          <FileKeyIcon />
                          {t("add.keyFile")}
                        </Button>
                      </>
                    }
                  >
                    <Textarea
                      id="srv-key"
                      rows={4}
                      className="font-mono text-xs"
                      placeholder={t("add.keyPh")}
                      value={f.key}
                      aria-invalid={!!errors.key || undefined}
                      onChange={(e) => up("key", e.target.value)}
                      spellCheck={false}
                    />
                  </Field>
                  <Field label={t("add.passphrase")} htmlFor="srv-pp">
                    <PasswordInput
                      id="srv-pp"
                      placeholder={t("common.optional")}
                      autoComplete="new-password"
                      value={f.passphrase}
                      onChange={(e) => up("passphrase", e.target.value)}
                    />
                  </Field>
                </>
              )}
              <div className="flex items-center gap-2">
                <Checkbox id="srv-remember" checked={f.remember} onCheckedChange={(v) => up("remember", v === true)} />
                <Label htmlFor="srv-remember" className="cursor-pointer text-[13px] font-normal">
                  {t("add.remember")}
                </Label>
                <Tip content={t("add.rememberTip")}>
                  <ShieldCheckIcon className="size-4 text-muted-foreground" tabIndex={0} />
                </Tip>
                {f.remember && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {vault.unlocked ? t("vault.unlocked") : vault.exists ? t("vault.locked") : t("vault.notCreated")}
                  </span>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {edit ? t("add.saveRedetect") : t("add.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <VaultDialog
        mode={vaultMode ?? "create"}
        open={vaultMode !== null}
        onOpenChange={(v) => !v && setVaultMode(null)}
        onDone={() => void doSubmit()}
      />
    </>
  );
}
