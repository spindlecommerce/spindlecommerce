import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { graphql, type ResultOf } from "@/graphql/graphql";
import { onSessionChange, refreshSession, request, signIn as apiSignIn, signOut as apiSignOut, verifySignIn } from "./api";

export const ViewerQuery = graphql(`
  query Viewer {
    viewer {
      permissions
      staffUser {
        id
        email
        name
        twoFactorEnabled
        recoveryCodesRemaining
        lastLoginAt
        roles {
          name
        }
      }
    }
  }
`);

export type Viewer = NonNullable<ResultOf<typeof ViewerQuery>["viewer"]>;
type Status = "loading" | "signedOut" | "signedIn";

type AuthContext = {
  status: Status;
  viewer: Viewer | null;
  /** `area:write` implies `area:read` and `*` grants all. A list passes if any one does. */
  can: (permission: string | readonly string[]) => boolean;
  signIn: (email: string, password: string) => Promise<{ kind: "session" } | { kind: "challenge"; challengeToken: string }>;
  verify: (challengeToken: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
};

const Context = createContext<AuthContext | null>(null);

export const hasPermission = (granted: readonly string[], required: string) => {
  if (granted.includes("*") || granted.includes(required)) return true;
  const [area, level] = required.split(":");
  return level === "read" && granted.includes(`${area}:write`);
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>("loading");
  const [viewer, setViewer] = useState<Viewer | null>(null);

  const loadViewer = useCallback(async () => {
    const data = await request(ViewerQuery);
    setViewer(data.viewer);
    setStatus("signedIn");
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (await refreshSession()) await loadViewer().catch(() => setStatus("signedOut"));
      else if (active) setStatus("signedOut");
    })();
    const unsubscribe = onSessionChange((signedIn) => {
      if (!signedIn) {
        setStatus("signedOut");
        setViewer(null);
        queryClient.clear();
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [loadViewer, queryClient]);

  const value = useMemo<AuthContext>(
    () => ({
      status,
      viewer,
      can: (permission) => (typeof permission === "string" ? [permission] : permission).some((p) => hasPermission(viewer?.permissions ?? [], p)),
      signIn: async (email, password) => {
        const result = await apiSignIn(email, password);
        if (result.kind === "session") await loadViewer();
        return result;
      },
      verify: async (challengeToken, code) => {
        await verifySignIn(challengeToken, code);
        await loadViewer();
      },
      signOut: async () => {
        await apiSignOut();
      },
      reload: loadViewer,
    }),
    [status, viewer, loadViewer],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export const useAuth = () => {
  const context = useContext(Context);
  if (!context) throw new Error("useAuth outside AuthProvider");
  return context;
};
