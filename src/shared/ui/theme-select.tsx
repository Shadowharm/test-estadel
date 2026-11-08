"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Icon } from "./icons";

const subscribe = () => () => {};
const modes = ["system", "light", "dark"] as const;
const labels = { system: "Как в системе", light: "Светлая", dark: "Тёмная" };
export function ThemeSelect() {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const { theme, setTheme } = useTheme();
  const current =
    mounted && modes.includes(theme as (typeof modes)[number])
      ? (theme as (typeof modes)[number])
      : "system";
  const next = modes[(modes.indexOf(current) + 1) % modes.length]!;
  const label = `Тема: ${labels[current]}. Включить: ${labels[next]}`;
  return (
    <button
      className="icon-button theme-toggle"
      type="button"
      aria-label={label}
      title={label}
      disabled={!mounted}
      onClick={() => setTheme(next)}
    >
      <Icon
        key={current}
        className="theme-icon"
        name={
          current === "system"
            ? "monitor"
            : current === "light"
              ? "sun"
              : "moon"
        }
      />
    </button>
  );
}
