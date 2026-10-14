import { ClipboardListIcon, PlusIcon, RadarIcon, RocketIcon, ServerIcon, ShieldCheckIcon, SparklesIcon, MousePointerClickIcon } from "lucide-react";
import { api, isMock } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ui } from "@/store/ui";
import { run } from "@/store/store";
import { t } from "@/i18n";
import { Logo } from "./TopBar";

export function Hero() {
  const steps = [
    { icon: <ServerIcon />, title: t("hero.step1"), desc: t("hero.step1d") },
    { icon: <RadarIcon />, title: t("hero.step2"), desc: t("hero.step2d") },
    { icon: <RocketIcon />, title: t("hero.step3"), desc: t("hero.step3d") },
  ];
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-4 py-10 md:px-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklch,var(--primary)_16%,transparent),transparent_70%),radial-gradient(40%_40%_at_90%_80%,color-mix(in_oklch,var(--info)_12%,transparent),transparent_70%)]"
      />
      <div className="relative grid w-full max-w-3xl gap-8">
        <div className="grid justify-items-center gap-4 text-center">
          <Logo className="size-14 drop-shadow-lg" />
          <h1 className="text-2xl font-bold tracking-tight md:text-4xl">{t("hero.title")}</h1>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">{t("hero.sub")}</p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Button size="lg" onClick={ui.openAdd}>
              <PlusIcon />
              {t("hero.cta")}
            </Button>
            <Button size="lg" variant="outline" onClick={() => ui.openPaste()}>
              <ClipboardListIcon />
              {t("hero.paste")}
            </Button>
            {isMock && (
              <Button size="lg" variant="ghost" onClick={() => void run(fetchSeed())}>
                <SparklesIcon />
                {t("hero.demo")}
              </Button>
            )}
          </div>
        </div>
        <ol className="grid gap-3 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={i} className="relative rounded-xl border bg-card/80 p-4 shadow-xs backdrop-blur">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">{s.icon}</span>
                <span className="text-xs font-semibold text-muted-foreground">0{i + 1}</span>
              </div>
              <div className="font-semibold">{s.title}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{s.desc}</p>
            </li>
          ))}
        </ol>
        <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-4 shrink-0 text-success" />
          {t("hero.privacy")}
        </p>
      </div>
    </div>
  );
}

export function SelectHint() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <MousePointerClickIcon className="size-8 opacity-50" />
      {t("hero.selectServer")}
    </div>
  );
}

/** 演示模式专用：载入示例服务器 */
async function fetchSeed() {
  const m = await import("@/api/mock");
  await m.mockFetch("POST", "/api/__mock/seed", {});
  return api.servers();
}
