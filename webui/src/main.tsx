import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { createTheme, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { App } from "./App";

const theme = createTheme({
  primaryColor: "blue",
  defaultRadius: "sm",
  fontFamily:
    'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="top-right" zIndex={2000} />
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
