import "./app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/feedback";
import { TooltipProvider } from "@/components/ui/overlay";
import { ApiError } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { applyTheme } from "@/lib/theme";
import { createAppRouter } from "./router";

applyTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // Permission and validation errors will not fix themselves.
      retry: (count, error) => !(error instanceof ApiError && ["PERMISSION_DENIED", "UNAUTHENTICATED", "VALIDATION_FAILED", "NOT_FOUND"].includes(error.code)) && count < 2,
    },
  },
});
const router = createAppRouter(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
