import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/utils";

export const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn("grid gap-2", className)} {...props} />
));
RadioGroup.displayName = "RadioGroup";

export const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      "aspect-square size-4 shrink-0 cursor-pointer rounded-full border border-input bg-card text-primary shadow-xs outline-none",
      "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary",
      className,
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
      <span className="size-2 rounded-full bg-primary" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = "RadioGroupItem";

/** 卡片式分段选择（radio-group 的变体） */
export function SegmentedRadio<T extends string>({
  value,
  onValueChange,
  options,
  className,
  columns,
  ariaLabel,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; desc?: React.ReactNode; icon?: React.ReactNode; tone?: "danger" }[];
  className?: string;
  columns?: string;
  ariaLabel?: string;
}) {
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      aria-label={ariaLabel}
      className={cn("grid gap-2", columns ?? "grid-cols-2 lg:grid-cols-4", className)}
    >
      {options.map((o) => (
        <RadioGroupPrimitive.Item
          key={o.value}
          value={o.value}
          className={cn(
            "group flex cursor-pointer flex-col items-start gap-1 rounded-lg border bg-card px-3 py-2.5 text-left transition-all outline-none",
            "hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/40",
            "data-[state=checked]:border-primary data-[state=checked]:bg-primary/[0.06] data-[state=checked]:shadow-[0_0_0_1px_var(--primary)]",
            o.tone === "danger" &&
              "data-[state=checked]:border-destructive data-[state=checked]:bg-destructive/[0.06] data-[state=checked]:shadow-[0_0_0_1px_var(--destructive)]",
          )}
        >
          <span className="flex items-center gap-1.5 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground group-data-[state=checked]:[&_svg]:text-primary">
            {o.icon}
            {o.label}
          </span>
          {o.desc && <span className="text-xs leading-snug text-muted-foreground">{o.desc}</span>}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
