import * as React from "react";
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { copyText } from "@/lib/dom";
import { t, type MessageKey } from "@/i18n";

// ---------- 状态徽标 ----------

const stateVariant: Record<string, "muted" | "info" | "primary" | "warning" | "success" | "destructive"> = {
  new: "muted",
  connecting: "info",
  ready: "primary",
  deploying: "warning",
  deployed: "success",
  error: "destructive",
};

export function StateBadge({ state, busy, className }: { state: string; busy?: boolean; className?: string }) {
  const spin = busy || state === "connecting" || state === "deploying";
  return (
    <Badge variant={stateVariant[state] ?? "muted"} className={className}>
      {spin ? (
        <Loader2Icon className="animate-spin" />
      ) : (
        <span className={cn("size-1.5 rounded-full bg-current", state === "new" && "opacity-50")} />
      )}
      {t(`state.${state}` as MessageKey) || state}
    </Badge>
  );
}

// ---------- 表单字段 ----------

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
  right,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      {(label || right) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <Label htmlFor={htmlFor} className="text-[13px]">
              {label}
            </Label>
          )}
          {right}
        </div>
      )}
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** 数字输入：空字符串视为 0 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  suffix,
  className,
  placeholder,
  ...rest
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: React.ReactNode;
  className?: string;
  placeholder?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max">) {
  const [text, setText] = React.useState(value ? String(value) : "");
  React.useEffect(() => {
    setText((cur) => (Number(cur || 0) === value ? cur : value ? String(value) : ""));
  }, [value]);
  const invalid = text !== "" && (isNaN(Number(text)) || (min !== undefined && Number(text) < min) || (max !== undefined && Number(text) > max));
  return (
    <div className={cn("relative", className)}>
      <Input
        inputMode="decimal"
        value={text}
        placeholder={placeholder ?? "0"}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          const n = Number(v || 0);
          if (!isNaN(n)) onChange(n);
        }}
        className={cn("tabular", suffix && "pr-12")}
        {...rest}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  );
}

export function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <Input {...props} type={show ? "text" : "password"} className={cn("pr-9", props.className)} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
        aria-label={show ? t("common.hide") : t("common.show")}
      >
        {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </button>
    </div>
  );
}

export function SwitchRow({
  id,
  label,
  desc,
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  id: string;
  label: React.ReactNode;
  desc?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="grid gap-1">
        <Label htmlFor={id} className="cursor-pointer text-[13px]">
          {label}
        </Label>
        {desc && <p className="text-xs leading-relaxed text-muted-foreground">{desc}</p>}
        {children}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

// ---------- 复制按钮 ----------

export function CopyButton({ text, className, label }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn("size-6 text-muted-foreground", className)}
      aria-label={label ?? t("common.copy")}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <CheckIcon className="text-success" /> : <CopyIcon />}
    </Button>
  );
}

// ---------- 空状态 ----------

export function EmptyState({
  icon,
  title,
  desc,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary [&_svg]:size-6">{icon}</div>
      )}
      <div className="grid gap-1">
        <h3 className="text-base font-semibold">{title}</h3>
        {desc && <p className="max-w-md text-sm text-muted-foreground">{desc}</p>}
      </div>
      {children && <div className="mt-1 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

// ---------- 通用确认框 ----------

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  desc,
  children,
  confirmText,
  destructive,
  onConfirm,
  disabled,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
  confirmText?: React.ReactNode;
  destructive?: boolean;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {desc && <AlertDialogDescription>{desc}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction destructive={destructive} disabled={disabled} onClick={onConfirm}>
            {confirmText ?? t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------- 提示条 ----------

export function Callout({
  tone = "info",
  icon,
  children,
  className,
}: {
  tone?: "info" | "warning" | "danger" | "success" | "muted";
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const cls = {
    info: "border-info/25 bg-info/8 text-foreground [&_.ci]:text-info",
    warning: "border-warning/40 bg-warning/10 text-foreground [&_.ci]:text-[color-mix(in_oklch,var(--warning)_80%,var(--foreground))]",
    danger: "border-destructive/30 bg-destructive/8 text-foreground [&_.ci]:text-destructive",
    success: "border-success/30 bg-success/8 text-foreground [&_.ci]:text-success",
    muted: "border-border bg-muted/50 text-muted-foreground [&_.ci]:text-muted-foreground",
  }[tone];
  return (
    <div className={cn("flex gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed", cls, className)}>
      {icon && <span className="ci mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">{children}</kbd>;
}
