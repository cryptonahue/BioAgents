import { useEffect, useRef, useCallback } from "preact/hooks";

export interface IngestionNotification {
  type: string;
  runId: string;
  filePath?: string;
  status?: string;
  progress?: {
    processed: number;
    skipped: number;
    failed: number;
    total: number;
  };
  llmCost?: number;
  llmCallsCount?: number;
  error?: string;
}

export function useIngestionWebSocket(runId: string | null, onNotification: (n: IngestionNotification) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const onNotificationRef = useRef(onNotification);
  onNotificationRef.current = onNotification;

  const connect = useCallback(() => {
    if (!runId) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Authenticate first
      const token = localStorage.getItem("bioagents_auth_token");
      const userId = localStorage.getItem("dev_user_id");
      ws.send(JSON.stringify({ action: "auth", token, userId }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "authenticated") {
          // Subscribe to run channel
          ws.send(JSON.stringify({ action: "subscribe", channel: `run:${runId}` }));
        }
        if (msg.type === "subscribed" && msg.channel?.startsWith("run:")) {
          console.log("Subscribed to run:", runId);
        }
        if (msg.runId || msg.type?.startsWith("ingestion") || msg.type?.startsWith("run:")) {
          onNotificationRef.current(msg as IngestionNotification);
        }
      } catch {}
    };

    ws.onclose = () => {
      wsRef.current = null;
      // Reconnect if runId is still active
      reconnectTimeoutRef.current = setTimeout(() => {
        if (runId) connect();
      }, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [runId]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
