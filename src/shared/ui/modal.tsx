"use client";

import { useEffect, useRef } from "react";
import { Icon } from "./icons";

export function Modal({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const startedOutside = useRef(false);
  const outside = (event: React.MouseEvent<HTMLDialogElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  useEffect(() => {
    const dialog = ref.current!;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    const previousScroll = { x: window.scrollX, y: window.scrollY };
    dialog.showModal();
    document.body.style.overflow = "hidden";
    window.scrollTo(previousScroll.x, previousScroll.y);
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        previousFocus !== document.body
      )
        previousFocus.focus({ preventScroll: true });
      else document.getElementById("main")?.focus({ preventScroll: true });
      window.scrollTo(previousScroll.x, previousScroll.y);
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={title}
      onPointerDown={(event) => {
        startedOutside.current = outside(event);
      }}
      onClick={(event) => {
        if (startedOutside.current && outside(event)) onClose();
        startedOutside.current = false;
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          autoFocus
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="icon-button"
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
