import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import App from "./App.tsx";
import { ThemeProvider } from "./lib/theme.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // 鉴权类错误不重试（会不断弹 401）
        const status = (error as { status?: number })?.status;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <App />
          <Toaster position="top-center" richColors={false} closeButton />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
