import { useEffect, useRef } from "react";
import { print } from "graphql";
import type { TadaDocumentNode } from "gql.tada";
import { API, currentToken, hasSession, refreshSession } from "./api";

/**
 * GraphQL subscriptions over SSE (Yoga's distinct-connection mode), read with fetch rather than
 * EventSource so the request can carry the Authorization header.
 */
export const useSubscription = <Result>(document: TadaDocumentNode<Result, Record<string, never>>, onData: (data: Result) => void, enabled = true) => {
  const handler = useRef(onData);
  handler.current = onData;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let attempt = 0;

    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          if (!hasSession()) await refreshSession();
          const { accessToken } = currentToken();
          const response = await fetch(API.graphql, {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", accept: "text/event-stream", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
            body: JSON.stringify({ query: print(document as Parameters<typeof print>[0]) }),
          });
          if (!response.ok || !response.body) throw new Error(`subscription failed (${response.status})`);
          attempt = 0;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const message = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = message
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              const payload = JSON.parse(data) as { data?: Result };
              if (payload.data) handler.current(payload.data);
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))));
      }
    };
    void connect();
    return () => controller.abort();
  }, [document, enabled]);
};
