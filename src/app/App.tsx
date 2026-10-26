import { useEffect } from "react";
import { AppShell } from "./AppShell";
import { logAppStarted } from "./logging";

export function App() {
  useEffect(() => {
    void logAppStarted();
  }, []);

  return <AppShell />;
}
