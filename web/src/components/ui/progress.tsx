import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

/** value 为 null 时显示不确定进度动画 */
export function Progress({
  className,
  value,
  indicatorClassName,
  ...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "value"> & {
  value: number | null;
  indicatorClassName?: string;
}) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  return (
    <ProgressPrimitive.Root
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-primary/15", className)}
      value={v}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          "h-full rounded-full bg-primary transition-[transform,width] duration-300",
          v == null && "animate-indeterminate w-2/5",
          indicatorClassName,
        )}
        style={v == null ? undefined : { width: `${v}%` }}
      />
    </ProgressPrimitive.Root>
  );
}
