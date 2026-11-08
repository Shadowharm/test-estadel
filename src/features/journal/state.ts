export const sorts = {
  seq: "По поступлению",
  created_at: "По времени события",
  source: "По источнику",
  type: "По типу",
  status: "По статусу",
} as const;
export type Conditions = {
  q: string;
  status: "" | "success" | "error";
  source: string[];
  type: string[];
  preset: "all" | "24h" | "7d" | "30d" | "custom";
  from: string;
  to: string;
  sort: keyof typeof sorts;
  direction: "asc" | "desc";
};
export const defaults: Conditions = {
  q: "",
  status: "",
  source: [],
  type: [],
  preset: "all",
  from: "",
  to: "",
  sort: "seq",
  direction: "desc",
};
export function readConditions(params: URLSearchParams): Conditions {
  const preset = params.get("preset") ?? "all";
  const sort = params.get("sort") ?? "seq";
  const direction = params.get("direction") ?? "desc";
  const status = params.get("status") ?? "";
  if (
    !["all", "24h", "7d", "30d"].includes(preset) ||
    !Object.hasOwn(sorts, sort) ||
    !["asc", "desc"].includes(direction) ||
    !["", "success", "error"].includes(status)
  )
    throw new Error("В ссылке указаны неизвестные условия или порядок.");
  const state = {
    ...defaults,
    q: params.get("q") ?? "",
    status,
    sort,
    direction,
    preset: params.has("from") || params.has("to") ? "custom" : preset,
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    source: [...new Set(params.getAll("source"))].sort(),
    type: [...new Set(params.getAll("type"))].sort(),
  } as Conditions;
  const error = validateConditions(state);
  if (error) throw new Error(error);
  if (state.preset === "custom") {
    state.from = new Date(state.from).toISOString();
    state.to = new Date(state.to).toISOString();
  }
  return state;
}
export function validateConditions(s: Conditions): string | null {
  if ([...s.q].length > 200 || /\p{Cc}/u.test(s.q))
    return "Поиск: не более 200 символов, без управляющих символов.";
  if (s.source.length > 20 || s.type.length > 20)
    return "Выберите не более 20 источников и 20 типов.";
  if (s.preset === "custom") {
    const a = Date.parse(s.from),
      b = Date.parse(s.to);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b)
      return "Укажите начало и конец периода; начало должно быть раньше конца.";
    if (b - a > 366 * 86400000) return "Максимальный период — 366 дней.";
  }
  return null;
}
export function conditionParams(s: Conditions, list = false): URLSearchParams {
  const p = new URLSearchParams();
  if (s.q.trim()) p.set("q", s.q.trim());
  if (s.status) p.set("status", s.status);
  for (const field of ["source", "type"] as const)
    [...s[field]].sort().forEach((v) => p.append(field, v));
  if (s.preset === "custom") {
    p.set("from", new Date(s.from).toISOString());
    p.set("to", new Date(s.to).toISOString());
  } else if (s.preset !== "all") p.set("preset", s.preset);
  if (list) {
    p.set("sort", s.sort);
    p.set("direction", s.direction);
  }
  return p;
}
export function workspaceHref(
  s: Conditions,
  view: "overview" | "events",
  id?: string,
) {
  const p = conditionParams(s, true);
  if (id) p.set("event", id);
  return `/${view}?${p}`;
}
export function eventHref(s: Conditions, id?: string) {
  return workspaceHref(s, "events", id);
}
export function formatTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
