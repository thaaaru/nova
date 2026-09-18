import { useEffect, useState } from "react";

export type TerminalSize = { columns: number; rows: number };

/**
 * Tracks the terminal's current dimensions so screens can switch between
 * a side-by-side two-pane layout and a stacked one below `NARROW_WIDTH_COLUMNS`.
 * Ink itself does not re-render on resize, so this listens to the raw
 * stdout "resize" event directly.
 */
export const NARROW_WIDTH_COLUMNS = 100;

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });

  useEffect(() => {
    function handleResize(): void {
      setSize({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    }
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  return size;
}
