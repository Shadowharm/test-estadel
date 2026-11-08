"use client";

import type { ComponentProps } from "react";

// Both routes render Workspace. Native history keeps its query and snapshot
// mounted when switching views, including after a manual refresh.
export function WorkspaceLink(props: ComponentProps<"a">) {
  return (
    <a
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        window.history.pushState(null, "", event.currentTarget.href);
        window.scrollTo({ top: 0, behavior: "auto" });
      }}
    />
  );
}
