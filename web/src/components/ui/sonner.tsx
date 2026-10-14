import { Toaster as Sonner } from "sonner";
import { useResolvedTheme } from "@/lib/theme";

export function Toaster() {
  const theme = useResolvedTheme();
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{ className: "text-sm" }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
    />
  );
}
