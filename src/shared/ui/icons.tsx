import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleCheck,
  Eye,
  Monitor,
  Moon,
  RefreshCw,
  Search,
  Sun,
  X,
  type LucideProps,
} from "lucide-react";

const icons = {
  eye: Eye,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  refresh: RefreshCw,
  up: ArrowUp,
  down: ArrowDown,
  search: Search,
  close: X,
  success: CircleCheck,
  error: CircleAlert,
  external: ArrowUpRight,
  check: Check,
};
export function Icon({
  name,
  className = "",
  ...props
}: LucideProps & { name: keyof typeof icons }) {
  const Component = icons[name];
  return (
    <Component
      size={18}
      strokeWidth={1.75}
      aria-hidden="true"
      focusable="false"
      className={`ui-icon ${className}`}
      {...props}
    />
  );
}
