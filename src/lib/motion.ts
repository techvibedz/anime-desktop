import { useEffect, useState } from "react";

// Accessibility: the mobile app honors the OS "reduce motion" switch; the
// desktop shell must too. Consumers use the hook to skip auto-advancing
// carousels and other non-essential motion.

const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    try {
      const mq = window.matchMedia(QUERY);
      const onChange = () => setReduced(mq.matches);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    } catch {
      return;
    }
  }, []);
  return reduced;
}
