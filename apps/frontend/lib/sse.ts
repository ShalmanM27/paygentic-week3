"use client";

// Connects to credit-agent /events SSE stream. Maintains a rolling buffer
// of the last 200 events. Reconnects with exponential backoff.

import { useEffect, useRef, useState } from "react";
import type { SseEvent } from "./types";

const BUFFER_SIZE = 200;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

function backoffWithJitter(attempt: number): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 16000;
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

export interface CreditEventsState {
  events: SseEvent[];
  connected: boolean;
  reconnectCount: number;
  lastHeartbeatAt: number | null;
}

export function useCreditEvents(baseUrl?: string): CreditEventsState {
  const url =
    baseUrl ??
    (typeof window !== "undefined"
      ? (process.env.NEXT_PUBLIC_CREDIT_AGENT_URL ?? "http://localhost:4000")
      : "http://localhost:4000");

  const [events, setEvents] = useState<SseEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;

    const connect = (): void => {
      if (stoppedRef.current) return;
      try {
        const es = new EventSource(`${url.replace(/\/+$/, "")}/events`);
        esRef.current = es;

        es.onopen = () => {
          setConnected(true);
          attemptRef.current = 0;
        };

        es.onmessage = (msg) => {
          try {
            const parsed = JSON.parse(msg.data) as SseEvent;
            if (parsed.kind === "system.heartbeat") {
              setLastHeartbeatAt(parsed.ts);
              return;
            }
            setEvents((prev) => {
              const next = [parsed, ...prev];
              return next.slice(0, BUFFER_SIZE);
            });
          } catch {
            /* ignore malformed frames */
          }
        };

        es.onerror = () => {
          setConnected(false);
          es.close();
          esRef.current = null;
          if (stoppedRef.current) return;
          const wait = backoffWithJitter(attemptRef.current);
          attemptRef.current += 1;
          setReconnectCount((n) => n + 1);
          setTimeout(connect, wait);
        };
      } catch {
        const wait = backoffWithJitter(attemptRef.current);
        attemptRef.current += 1;
        setReconnectCount((n) => n + 1);
        setTimeout(connect, wait);
      }
    };

    connect();
    return () => {
      stoppedRef.current = true;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [url]);

  return { events, connected, reconnectCount, lastHeartbeatAt };
}
